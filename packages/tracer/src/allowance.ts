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
 * The parts of an `EXPERIMENTAL_tx_status` / send-transaction response that
 * `tracerSignStatus` reads. Everything is optional because a response for a
 * transaction that is not yet executed carries no outcomes.
 */
export type TxStatusView = {
  transaction_outcome?: { id?: string; outcome?: { receipt_ids?: string[] } };
  receipts_outcome?: { id: string; outcome: { status: unknown } }[];
};

export type TracerSignStatus = { kind: "pending" } | { kind: "accepted" } | { kind: "failed"; message: string };

/**
 * Whether `tracer_sign` itself (the transaction's first receipt, executed on
 * the Allowance) has run, and if it panicked, why. Later receipts (funding,
 * signing) are tracked through `get_signed_payment` instead.
 */
export function tracerSignStatus(tx: TxStatusView): TracerSignStatus {
  const receiptId = tx.transaction_outcome?.outcome?.receipt_ids?.[0];
  const receipt = receiptId === undefined ? undefined : tx.receipts_outcome?.find(r => r.id === receiptId);
  const status = receipt?.outcome.status;
  if (status === undefined || status === null || typeof status !== "object") return { kind: "pending" };
  if ("Failure" in status) return { kind: "failed", message: describeFailure(status.Failure) };
  return { kind: "accepted" };
}

/** The contract's panic message when there is one, else the raw failure. */
function describeFailure(failure: unknown): string {
  const kind = (failure as { ActionError?: { kind?: unknown } } | null)?.ActionError?.kind;
  const call = (kind as { FunctionCallError?: unknown } | undefined)?.FunctionCallError;
  if (call && typeof call === "object") {
    const execution = (call as { ExecutionError?: unknown }).ExecutionError;
    if (typeof execution === "string") return execution;
    const panic = (call as { HostError?: { GuestPanic?: { panic_msg?: unknown } } }).HostError?.GuestPanic?.panic_msg;
    if (typeof panic === "string") return `Smart contract panicked: ${panic}`;
  }
  return JSON.stringify(failure);
}

/**
 * Calls `tracer_sign` as the Allowance itself, i.e. `agent` must be an
 * `Account` for the Allowance id signing with the Agent's function-call key.
 * Returns once the transaction is in a final block, with the transaction hash
 * and whatever is already known about the `tracer_sign` receipt; signing
 * completes asynchronously.
 */
export async function tracerSign(
  agent: Account,
  args: TracerSignArgs,
): Promise<{ txHash: string; status: TracerSignStatus }> {
  const outcome = await agent.callFunctionRaw({
    contractId: agent.accountId,
    methodName: "tracer_sign",
    args,
    gas: 300n * TGAS,
    deposit: 0n,
    waitUntil: "INCLUDED_FINAL",
  });
  return { txHash: outcome.transaction_outcome.id, status: tracerSignStatus(outcome as TxStatusView) };
}
