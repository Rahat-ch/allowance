/**
 * The Agent side of an x402 payment in the harness. The implementation is the MCP
 * server's client (packages/mcp): the official x402 fetch wrapper and NEAR `exact`
 * client scheme, with a signer that submits a Spend Request to the Allowance (with the
 * Agent's function-call key) and hands the seller the Signed Payment the contract issued.
 * These helpers bind it to a Harness.
 */
import {
  AllowanceClient,
  nearAllowance,
  type Budget,
  type KeyPool,
  type SpendArgs,
  type SpendRequest,
} from "allowance-mcp";
import { NETWORK, type Harness } from "./harness.js";

export {
  BUSY,
  NotPaid,
  SPEND_GAS,
  newRequestId,
  type BlockedReason,
  type Budget,
  type KeyPool,
  type Outcome,
  type SpendArgs,
  type SpendRequest,
  type Status,
} from "allowance-mcp";

/** The Agent's client for this harness's Allowance; polls also check the mock signer's health. */
export function agentClient(h: Harness, signTimeoutMs = 60_000): AllowanceClient {
  return new AllowanceClient(nearAllowance(h.agent, h.allowance.accountId), {
    network: NETWORK,
    signTimeoutMs,
    pollIntervalMs: 250,
    onPoll: () => h.assertResponderHealthy(),
  });
}

/**
 * Submits a Spend Request as the Agent and returns it with its Outcome. Rejects with
 * the contract's message if the call panics. An Approved request's Signed Payment
 * arrives later: see `waitForPayment`.
 */
export function requestSpend(h: Harness, args: SpendArgs): Promise<SpendRequest> {
  return agentClient(h).requestSpend(args);
}

export function getRequest(h: Harness, requestId: string): Promise<SpendRequest | null> {
  return agentClient(h).getRequest(requestId);
}

export function getBudget(h: Harness): Promise<Budget> {
  return agentClient(h).contract.getBudget();
}

/** The Payer Account's signing keys: how many are free for a new Signed Payment. */
export function getKeyPool(h: Harness): Promise<KeyPool> {
  return agentClient(h).contract.getKeyPool();
}

/** Polls until the request is no longer moving money (Funding) or being signed (Signing). */
export function waitForPayment(h: Harness, requestId: string, timeoutMs = 60_000): Promise<SpendRequest> {
  return agentClient(h).waitForPayment(requestId, timeoutMs);
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
  return agentClient(h).fetch({
    memo: "harness x402 call",
    baseFetch,
    ...(onRequest ? { onRequest: (id: string) => onRequest(id) } : {}),
    ...(resumeRequestId ? { requestId: resumeRequestId } : {}),
  });
}
