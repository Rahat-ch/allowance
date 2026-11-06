/**
 * The Agent side of an x402 payment in the harness: the official x402 fetch
 * wrapper and NEAR `exact` client scheme, with a signer that submits a Spend
 * Request to the Allowance (with the Agent's function-call key) and hands the
 * seller the Signed Payment the contract issued.
 */
import { randomBytes } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactNearScheme } from "@x402/near/exact/client";
import { NETWORK, TGAS, type Harness } from "./harness.js";

export type Outcome = "Approved" | "Pending" | "Blocked";
export type Status =
  | "Blocked"
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Expired"
  | "Lapsed"
  | "Funding"
  | "Signing"
  | "Signed"
  | "FundingFailed"
  | "SignatureUnavailable";
export type BlockedReason =
  | "UnknownPayee"
  | "OverHardCeiling"
  | "DailyCapExceeded"
  | "VelocityExceeded"
  | "Paused"
  | "Revoked"
  | "IdempotencyConflict"
  | "InvalidRequest";

export type SpendRequest = {
  request_id: string;
  payee: string;
  amount: string;
  memo: string | null;
  max_timeout_blocks: number;
  requested_at_ns: number;
  outcome: Outcome;
  status: Status;
  blocked_reason: BlockedReason | null;
  limit: { used: string; limit: string; retry_after_ns: number | null } | null;
  reserved_hour: number | null;
  /** False for a Blocked request beyond the per-hour storage budget: only its event records it. */
  stored: boolean;
  expires_at_ns: number | null;
  pickup_deadline_ns: number | null;
  payment: {
    key_index: number;
    public_key: string;
    nonce: number;
    max_block_height: number;
    signed_delegate_action: string | null;
  } | null;
};

export type SpendArgs = {
  request_id: string;
  payee: string;
  amount: bigint;
  memo?: string;
  max_timeout_blocks: number;
  /** Gas to attach (default SPEND_GAS). A Blocked request needs far less. */
  gas?: bigint;
};

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/**
 * Submits a Spend Request as the Agent and returns it with its Outcome. Rejects with
 * the contract's message if the call panics. An Approved request's Signed Payment
 * arrives later: see `waitForPayment`.
 */
export async function requestSpend(h: Harness, args: SpendArgs): Promise<SpendRequest> {
  return h.callNow<SpendRequest>(
    h.agent,
    h.allowance.accountId,
    "request_spend",
    {
    request_id: args.request_id,
    payee: args.payee,
    amount: args.amount.toString(),
    memo: args.memo ?? null,
    max_timeout_blocks: args.max_timeout_blocks,
    },
    args.gas ?? SPEND_GAS,
  );
}

/** request_spend plus the funding and signing callbacks it schedules (~130 TGas). */
export const SPEND_GAS = 150n * TGAS;

export async function getRequest(h: Harness, requestId: string): Promise<SpendRequest | null> {
  return h.view<SpendRequest | null>(h.allowance.accountId, "get_request", { request_id: requestId });
}

export type Budget = {
  used_in_window: string;
  daily_cap: string;
  available: string;
  next_release_ns: number | null;
  velocity_used: number;
  velocity_limit: number;
  /** USDC the Allowance holds (credited deposits, less transfers out). */
  usdc_balance: string;
  /** Pending + approved-unsigned amounts. */
  held: string;
  /** usdc_balance - held: what the Owner may Withdraw. */
  withdrawable: string;
  /** The Allowance account's NEAR, in yoctoNEAR. */
  near_balance: string;
};

export async function getBudget(h: Harness): Promise<Budget> {
  return h.view<Budget>(h.allowance.accountId, "get_budget");
}

export type KeyPool = { keys: number; free: number; next_free_height: number | null };

/** The Payer Account's signing keys: how many are free for a new Signed Payment. */
export async function getKeyPool(h: Harness): Promise<KeyPool> {
  return h.view<KeyPool>(h.allowance.accountId, "get_key_pool");
}

/** request_spend refuses with this when every signing key is leased; retry the same Request ID. */
export const BUSY = /busy: all signing keys are in use/;

/** Polls until the request is no longer moving money (Funding) or being signed (Signing). */
export async function waitForPayment(h: Harness, requestId: string, timeoutMs = 60_000): Promise<SpendRequest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await getRequest(h, requestId);
    h.assertResponderHealthy();
    if (r && r.status !== "Funding" && r.status !== "Signing") return r;
    if (Date.now() > deadline) throw new Error(`request ${requestId} still ${r?.status ?? "missing"} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Thrown when the Allowance doesn't produce a Signed Payment for a seller's offer. */
export class NotPaid extends Error {
  constructor(readonly request: SpendRequest) {
    super(`not paid: ${request.outcome} ${request.status}${request.blocked_reason ? ` (${request.blocked_reason})` : ""}`);
  }
}

/**
 * `fetch` that pays x402 sellers through the Allowance. `baseFetch` is what
 * actually sends the requests (tests wrap it to see the PAYMENT-SIGNATURE).
 */
export function allowanceFetch(
  h: Harness,
  onRequest?: (requestId: string) => void,
  baseFetch: typeof fetch = fetch,
  /** Re-submit this Request ID instead of minting one: how an approved spend is picked up. */
  resumeRequestId?: string,
): typeof fetch {
  const client = new x402Client()
    // The Allowance enforces the Policy; the client's default $1 cap must not second-guess it.
    .setSpendControls(false)
    .register(
      NETWORK,
      new ExactNearScheme({
        async createSignedDelegateAction({ paymentRequirements: requirements }) {
          const requestId = resumeRequestId ?? newRequestId();
          onRequest?.(requestId);
          const submitted = await requestSpend(h, {
            request_id: requestId,
            payee: requirements.payTo,
            amount: BigInt(requirements.amount),
            memo: "harness x402 call",
            // ~1 block per second; the contract clamps it to the Policy maximum anyway.
            max_timeout_blocks: Math.min(requirements.maxTimeoutSeconds, h.policy.max_timeout_blocks),
          });
          // Paying: newly Approved, or an approved spend just picked up.
          const paying = ["Funding", "Signing", "Signed"].includes(submitted.status);
          if (!paying || submitted.blocked_reason) throw new NotPaid(submitted);
          const r = await waitForPayment(h, requestId);
          if (r.status !== "Signed" || !r.payment?.signed_delegate_action) throw new NotPaid(r);
          return r.payment.signed_delegate_action;
        },
      }),
    );
  return wrapFetchWithPayment(baseFetch, client) as typeof fetch;
}
