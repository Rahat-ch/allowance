/**
 * The Agent side of an x402 payment in the harness: the official x402 fetch
 * wrapper and NEAR `exact` client scheme, with a signer that asks the
 * Allowance for a Signed Payment instead of signing anything itself.
 */
import { randomBytes } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactNearScheme } from "@x402/near/exact/client";
import { NETWORK, type Harness } from "./harness.js";

export type PaymentStatus = "Funding" | "Signing" | "Signed" | "FundingFailed" | "SignatureUnavailable";

export type SignedPayment = {
  status: PaymentStatus;
  payee: string;
  amount: string;
  key_index: number;
  max_timeout_blocks: number;
  public_key: string | null;
  nonce: number | null;
  max_block_height: number | null;
  signed_delegate_action: string | null;
};

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/**
 * Submits the tracer request. Resolves once the contract accepted it (rejects with the
 * panic message if not); signing finishes later.
 */
export async function requestSignedPayment(
  h: Harness,
  args: { request_id: string; payee: string; amount: bigint; max_timeout_blocks: number },
): Promise<void> {
  await h.callNow(h.allowance, h.allowance.accountId, "tracer_sign", { ...args, amount: args.amount.toString() });
}

export async function getSignedPayment(h: Harness, requestId: string): Promise<SignedPayment | null> {
  return h.view<SignedPayment | null>(h.allowance.accountId, "get_signed_payment", { request_id: requestId });
}

/** Polls until the request leaves Funding/Signing. */
export async function waitForSignedPayment(h: Harness, requestId: string, timeoutMs = 60_000): Promise<SignedPayment> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await getSignedPayment(h, requestId);
    h.assertResponderHealthy();
    if (p && p.status !== "Funding" && p.status !== "Signing") return p;
    if (Date.now() > deadline) throw new Error(`request ${requestId} still ${p?.status ?? "missing"} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** `fetch` that pays x402 sellers through the Allowance. */
export function allowanceFetch(h: Harness, onRequest?: (requestId: string) => void): typeof fetch {
  const client = new x402Client()
    // The Allowance enforces the Policy; the client's default $1 cap must not second-guess it.
    .setSpendControls(false)
    .register(
      NETWORK,
      new ExactNearScheme({
        async createSignedDelegateAction({ paymentRequirements: requirements }) {
          const requestId = newRequestId();
          onRequest?.(requestId);
          await requestSignedPayment(h, {
            request_id: requestId,
            payee: requirements.payTo,
            amount: BigInt(requirements.amount),
            max_timeout_blocks: requirements.maxTimeoutSeconds,
          });
          const p = await waitForSignedPayment(h, requestId);
          if (p.status !== "Signed" || !p.signed_delegate_action) throw new Error(`no Signed Payment: ${p.status}`);
          return p.signed_delegate_action;
        },
      }),
    );
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}
