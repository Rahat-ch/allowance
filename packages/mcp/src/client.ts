/**
 * The Agent side of an x402 payment through the Allowance, shared by the MCP server and
 * the sandbox tests.
 *
 * The official x402 fetch wrapper and NEAR `exact` client scheme do the HTTP part: read
 * the seller's PAYMENT-REQUIRED, attach PAYMENT-SIGNATURE, retry. The scheme's signer
 * never signs anything locally: it submits a Spend Request to the Allowance with the
 * Agent's function-call key, polls the request until the contract has issued its Signed
 * Payment, and hands that to the seller.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactNearScheme } from "@x402/near/exact/client";
import {
  BusyError,
  FINAL_UNPAID,
  IN_FLIGHT,
  newRequestId,
  type AllowanceContract,
  type SpendArgs,
  type SpendRequest,
} from "./contract.js";
import { sameOffer, selectOffer, type OfferRefusal, type OfferWanted } from "./offers.js";

export type ClientOptions = {
  /** CAIP-2 network the Allowance pays on (`near:testnet` or `near:mainnet`). */
  network: Network;
  /** How long to wait for the Signed Payment after a Spend Request (default 90 s). */
  signTimeoutMs?: number;
  /** Delay between `get_request` polls (default 500 ms). */
  pollIntervalMs?: number;
  /** Called on every poll; the sandbox uses it to surface mock-signer failures. */
  onPoll?: () => void;
  /** Sends the HTTP requests (default global fetch). */
  fetch?: typeof fetch;
};

/** The Allowance didn't produce a Signed Payment for the seller's offer. */
export class NotPaid extends Error {
  constructor(readonly request: SpendRequest) {
    super(`not paid: ${request.outcome} ${request.status}${request.blocked_reason ? ` (${request.blocked_reason})` : ""}`);
    this.name = "NotPaid";
  }
}

/** The signature was still on its way when the wait ended; the request has not failed. */
export class StillSigning extends Error {
  constructor(
    readonly requestId: string,
    readonly request: SpendRequest | null,
    timeoutMs: number,
  ) {
    super(`request ${requestId} still ${request?.status ?? "missing"} after ${timeoutMs}ms`);
    this.name = "StillSigning";
  }
}

/** No offer in the seller's 402 is one the Allowance may pay under the Agent's limits. */
export class OfferRefused extends Error {
  constructor(readonly refusal: OfferRefusal) {
    super(`offer refused: ${refusal.reason}: ${refusal.message}`);
    this.name = "OfferRefused";
  }
}

export type FetchOptions = {
  /** Re-submit this Request ID instead of minting one: how an approved spend is picked up. */
  requestId?: string;
  memo?: string | null;
  /** Called with the Request ID and the offer just before the Spend Request is submitted. */
  onRequest?: (requestId: string, offer: PaymentRequirements) => void;
  /** Called with every state of the Spend Request this fetch sees. */
  onSpend?: (request: SpendRequest) => void;
  /**
   * Called with the error when no Signed Payment came of the Spend Request (NotPaid,
   * BusyError, StillSigning...). The x402 wrapper rewraps such errors, losing their type.
   */
  onSpendError?: (error: unknown) => void;
  /** Restricts which offer is paid; a refusal throws OfferRefused before any Spend Request. */
  offer?: Omit<OfferWanted, "network" | "asset">;
  /** Sends the HTTP requests (default: the client's). */
  baseFetch?: typeof fetch;
};

export type PayInput = {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Most the Agent will pay for this call, in USDC base units. */
  maxAmount: bigint;
  /** Use this Request ID; an existing one is resumed (its Payee and amount are enforced). */
  requestId?: string;
  memo?: string;
  /** Only continue an existing Request ID; never create one. */
  resumeOnly?: boolean;
};

/** What happened to one paid call, as data; the MCP layer shapes it for the Agent. */
export type PayOutcome =
  /** The seller answered without asking for payment. */
  | { kind: "free"; response: Response }
  /** A Signed Payment was handed to the seller; `response` is its answer. */
  | { kind: "paid"; request: SpendRequest; offer: PaymentRequirements; response: Response; settlement: SettleResponse | null; sellerError: string | null }
  /** The Allowance did not pay (Pending, Blocked, Rejected, pickup refused...). */
  | { kind: "not_paid"; request: SpendRequest; offer: PaymentRequirements | null }
  /** Every signing key is in use; nothing was stored or reserved. Retry the same Request ID. */
  | { kind: "busy"; requestId: string; offer: PaymentRequirements; message: string }
  /** The Spend Request was made but its Signed Payment had not arrived when the wait ended. */
  | { kind: "still_signing"; requestId: string; request: SpendRequest | null; offer: PaymentRequirements }
  /** No offer qualified; no Spend Request was made. */
  | { kind: "refused"; refusal: OfferRefusal }
  /** `resumeOnly` and the Allowance has no such request. */
  | { kind: "unknown_request"; requestId: string }
  /** Something failed after a Spend Request may have been made: its fate is uncertain. */
  | { kind: "error"; requestId: string; message: string };

export class AllowanceClient {
  readonly network: Network;
  private readonly signTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onPoll: (() => void) | undefined;
  private readonly baseFetch: typeof fetch;

  constructor(
    readonly contract: AllowanceContract,
    options: ClientOptions,
  ) {
    this.network = options.network;
    this.signTimeoutMs = options.signTimeoutMs ?? 90_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.onPoll = options.onPoll;
    this.baseFetch = options.fetch ?? fetch;
  }

  requestSpend(args: SpendArgs): Promise<SpendRequest> {
    return this.contract.requestSpend(args);
  }

  getRequest(requestId: string): Promise<SpendRequest | null> {
    return this.contract.getRequest(requestId);
  }

  /** Polls until the request is no longer moving money (Funding) or being signed (Signing). */
  async waitForPayment(requestId: string, timeoutMs = this.signTimeoutMs): Promise<SpendRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.contract.getRequest(requestId);
      this.onPoll?.();
      if (r && !IN_FLIGHT.includes(r.status)) return r;
      if (Date.now() > deadline) throw new StillSigning(requestId, r, timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /**
   * Submits the Spend Request for `offer` and waits for its Signed Payment (base64 borsh
   * SignedDelegateAction). Throws NotPaid, BusyError or StillSigning otherwise.
   */
  async signedPaymentFor(
    offer: PaymentRequirements,
    requestId: string,
    memo: string | null,
    onSpend?: (r: SpendRequest) => void,
  ): Promise<string> {
    const submitted = await this.contract.requestSpend({
      request_id: requestId,
      payee: offer.payTo,
      amount: BigInt(offer.amount),
      memo,
      // ~1 block per second; the contract clamps it to the Policy maximum.
      max_timeout_blocks: offer.maxTimeoutSeconds,
    });
    onSpend?.(submitted);
    // Paying: newly Approved, or an approved spend just picked up.
    const paying = submitted.status === "Signed" || IN_FLIGHT.includes(submitted.status);
    if (!paying || submitted.blocked_reason) throw new NotPaid(submitted);
    const r = await this.waitForPayment(requestId);
    onSpend?.(r);
    if (r.status !== "Signed" || !r.payment?.signed_delegate_action) throw new NotPaid(r);
    return r.payment.signed_delegate_action;
  }

  /**
   * `fetch` that pays x402 sellers through the Allowance, built on the official x402
   * client. An unpaid outcome rejects; the x402 wrapper rewraps the error, so use
   * `onSpend` / `onSpendError` to see what happened.
   */
  fetch(options: FetchOptions = {}): typeof fetch {
    let chosen: PaymentRequirements | undefined;
    const client = new x402Client()
      // The Allowance enforces the Policy; the client's default $1 cap must not second-guess it.
      .setSpendControls(false)
      // When `options.offer` is set, only the offer chosen in onPaymentRequired may be paid.
      .registerPolicy((_version, offers) => (chosen ? offers.filter((o) => sameOffer(o, chosen!)) : offers))
      .register(
        this.network,
        new ExactNearScheme({
          createSignedDelegateAction: async ({ paymentRequirements: offer }) => {
            const requestId = options.requestId ?? newRequestId();
            options.onRequest?.(requestId, offer);
            try {
              return await this.signedPaymentFor(offer, requestId, options.memo ?? null, options.onSpend);
            } catch (error) {
              options.onSpendError?.(error);
              throw error;
            }
          },
        }),
      );
    const http = new x402HTTPClient(client);
    if (options.offer) {
      const wanted = options.offer;
      http.onPaymentRequired(async ({ paymentRequired }) => {
        const asset = await this.contract.getAsset();
        const choice = selectOffer(paymentRequired.accepts, { ...wanted, network: this.network, asset });
        // Thrown before any Spend Request; the x402 wrapper passes hook errors through as is.
        if (!choice.ok) throw new OfferRefused(choice.refusal);
        chosen = choice.offer;
      });
    }
    return wrapFetchWithPayment(options.baseFetch ?? this.baseFetch, http) as typeof fetch;
  }

  /**
   * One paid HTTP call with every outcome as data: fetch; on 402 pick the offer; submit
   * the Spend Request (or re-submit `requestId`); wait for the Signed Payment; retry with
   * PAYMENT-SIGNATURE. Rejects only when nothing was asked of the Allowance.
   */
  async pay(input: PayInput): Promise<PayOutcome> {
    const requestId = input.requestId ?? newRequestId();
    let memo: string | null = input.memo ?? null;
    let wanted: Omit<OfferWanted, "network" | "asset"> = { maxAmount: input.maxAmount };

    if (input.requestId !== undefined) {
      const existing = await this.contract.getRequest(requestId);
      if (!existing && input.resumeOnly) return { kind: "unknown_request", requestId };
      if (existing) {
        // Bound forever to its first Payee, amount and memo: re-submit exactly those.
        memo = existing.memo;
        const amount = BigInt(existing.amount);
        wanted = { maxAmount: input.resumeOnly ? amount : input.maxAmount, request: { payee: existing.payee, amount } };
        // Nothing to pay yet (Pending) or ever (Blocked, Rejected...): don't call the seller.
        if (existing.status === "Pending" || FINAL_UNPAID.includes(existing.status)) {
          return { kind: "not_paid", request: existing, offer: null };
        }
      }
    }

    let offer: PaymentRequirements | undefined;
    let last: SpendRequest | undefined;
    let spendError: unknown;
    const paidFetch = this.fetch({
      requestId,
      memo,
      offer: wanted,
      onRequest: (_id, o) => (offer = o),
      onSpend: (r) => (last = r),
      onSpendError: (e) => (spendError = e),
    });

    let response: Response;
    try {
      response = await paidFetch(input.url, {
        method: input.method ?? "GET",
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      });
    } catch (error) {
      if (error instanceof OfferRefused) return { kind: "refused", refusal: error.refusal };
      if (offer === undefined) throw error; // nothing was asked of the Allowance
      if (spendError instanceof BusyError) return { kind: "busy", requestId, offer, message: spendError.message };
      if (spendError instanceof StillSigning) return { kind: "still_signing", requestId, request: spendError.request, offer };
      if (spendError instanceof NotPaid) return { kind: "not_paid", request: spendError.request, offer };
      return { kind: "error", requestId, message: error instanceof Error ? error.message : String(error) };
    }
    if (offer === undefined || last === undefined) return { kind: "free", response };

    const settlementHeader = response.headers.get("payment-response");
    const settlement = settlementHeader ? safely(() => decodePaymentResponseHeader(settlementHeader)) : null;
    const requiredHeader = response.status === 402 ? response.headers.get("payment-required") : null;
    const sellerError = requiredHeader ? (safely(() => decodePaymentRequiredHeader(requiredHeader))?.error ?? null) : null;
    return { kind: "paid", request: last, offer, response, settlement, sellerError };
  }
}

function safely<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}
