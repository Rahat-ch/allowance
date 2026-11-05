/**
 * The Allowance contract's tracer surface (ticket #2), as the contract
 * exposes it: JSON args, u128 amounts as decimal strings.
 */
import type { Account } from "near-api-js";
import { TGAS, view } from "./near.js";

export type SignedPaymentStatus = "Funding" | "Signing" | "Signed" | "FundingFailed" | "SignatureUnavailable";

/** `get_signed_payment` result. */
export type SignedPayment = {
  status: SignedPaymentStatus;
  payee: string;
  amount: string;
  key_index: number;
  max_timeout_blocks: number;
  public_key: string;
  nonce: string | number;
  max_block_height: string | number;
  /** Base64 borsh `SignedDelegateAction`, once `status` is `Signed`. */
  signed_delegate_action: string | null;
};

const TERMINAL: ReadonlySet<SignedPaymentStatus> = new Set(["Signed", "FundingFailed", "SignatureUnavailable"]);

export function isTerminal(status: SignedPaymentStatus): boolean {
  return TERMINAL.has(status);
}

export function getSignedPayment(allowanceId: string, requestId: string): Promise<SignedPayment | null> {
  return view<SignedPayment | null>(allowanceId, "get_signed_payment", { request_id: requestId });
}

export function payerAccountId(allowanceId: string): Promise<string> {
  return view<string>(allowanceId, "payer_account_id");
}

export function payerKeys(allowanceId: string): Promise<string[]> {
  return view<string[]>(allowanceId, "payer_keys");
}

export type TracerSignArgs = {
  request_id: string;
  payee: string;
  amount: string;
  max_timeout_blocks: number;
};

/**
 * Calls `tracer_sign` as the Allowance itself, i.e. `agent` must be an
 * `Account` for the Allowance id signing with the Agent's function-call key.
 * Returns the transaction hash; signing completes asynchronously.
 */
export async function tracerSign(agent: Account, args: TracerSignArgs): Promise<string> {
  const outcome = await agent.callFunctionRaw({
    contractId: agent.accountId,
    methodName: "tracer_sign",
    args,
    gas: 300n * TGAS,
    deposit: 0n,
    waitUntil: "INCLUDED_FINAL",
  });
  return outcome.transaction_outcome.id;
}
