/**
 * The Allowance contract as the Agent sees it: `request_spend` (the only method its
 * function-call key may call) and the views. Types mirror the contract's JSON.
 */
import { randomBytes } from "node:crypto";
import type { Account, Provider } from "near-api-js";

export const TGAS = 1_000_000_000_000n;
/** request_spend plus the funding and signing callbacks it schedules (~130 TGas). */
export const SPEND_GAS = 150n * TGAS;

export type Outcome = "Approved" | "Pending" | "Blocked";
export type Status =
  | "Blocked"
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Expired"
  | "Lapsed"
  | "Cancelled"
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
  memo?: string | null;
  max_timeout_blocks: number;
  /** Gas to attach (default SPEND_GAS). A Blocked request needs far less. */
  gas?: bigint;
};

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

/** Amounts are USDC base units as strings. */
export type Policy = {
  daily_cap: string;
  auto_limit: string;
  hard_ceiling: string;
  velocity_limit: number;
  max_timeout_blocks: number;
};

export type KeyPool = { keys: number; free: number; next_free_height: number | null };

/** request_spend refuses with this when every signing key is leased; retry the same Request ID. */
export const BUSY = /busy: all signing keys are in use/;

/** Every Payer Account key is leased: nothing was stored or reserved; retry the same Request ID. */
export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusyError";
  }
}

/** Statuses after which a request will never pay. */
export const FINAL_UNPAID: readonly Status[] = ["Blocked", "Rejected", "Expired", "Lapsed", "Cancelled", "FundingFailed", "SignatureUnavailable"];
/** The Allowance is moving money into the Payer Account or waiting for the signature. */
export const IN_FLIGHT: readonly Status[] = ["Funding", "Signing"];

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/** What the Agent can do with its Allowance. A stub stands in for it in unit tests. */
export interface AllowanceContract {
  readonly allowanceId: string;
  /** Submits (or re-submits) a Spend Request. Throws BusyError when every signing key is leased. */
  requestSpend(args: SpendArgs): Promise<SpendRequest>;
  getRequest(requestId: string): Promise<SpendRequest | null>;
  getBudget(): Promise<Budget>;
  getPolicy(): Promise<Policy>;
  getAllowlist(): Promise<string[]>;
  getAsset(): Promise<string>;
  getKeyPool(): Promise<KeyPool>;
}

/**
 * The Allowance on chain, reached as the Agent: `agent` is the Allowance account signed
 * by the Agent's function-call key (which may only call `request_spend`).
 */
export function nearAllowance(agent: Account, allowanceId: string = agent.accountId): AllowanceContract {
  const provider = agent.provider;
  const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
    (await provider.callFunction({ contractId: allowanceId, method, args })) as T;
  let asset: Promise<string> | undefined;
  return {
    allowanceId,
    async requestSpend(args) {
      try {
        return await callNow<SpendRequest>(
          agent,
          allowanceId,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (BUSY.test(message)) throw new BusyError(message);
        throw error;
      }
    },
    getRequest: (requestId) => view<SpendRequest | null>("get_request", { request_id: requestId }),
    getBudget: () => view<Budget>("get_budget"),
    getPolicy: () => view<Policy>("get_policy"),
    getAllowlist: () => view<string[]>("get_allowlist"),
    // Fixed at initialization, so read it once.
    getAsset: () => (asset ??= view<string>("get_asset").catch((e) => ((asset = undefined), Promise.reject(e)))),
    getKeyPool: () => view<KeyPool>("get_key_pool"),
  };
}

/**
 * Calls `method` and resolves with the first receipt's return value once it has
 * executed, without waiting for the callbacks it scheduled (signing can take a while).
 * A panic in the method rejects with its message.
 */
export async function callNow<T>(
  account: Account,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
  gas = 300n * TGAS,
): Promise<T> {
  const provider: Provider = account.provider;
  const tx = await account.callFunctionRaw({ contractId, methodName: method, args, gas, waitUntil: "INCLUDED_FINAL" });
  const txHash = tx.transaction_outcome.id;
  const receiptId = tx.transaction_outcome.outcome.receipt_ids[0];
  for (let i = 0; i < 200; i++) {
    const status = await provider.viewTransactionStatusWithReceipts({ txHash, accountId: account.accountId, waitUntil: "INCLUDED" });
    const outcome = status.receipts_outcome.find((r) => r.id === receiptId)?.outcome.status as
      | { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown }
      | string
      | undefined;
    if (outcome !== undefined && typeof outcome === "object") {
      if (outcome.Failure !== undefined) throw new Error(`${method} failed: ${JSON.stringify(outcome.Failure)}`);
      if (outcome.SuccessValue !== undefined) {
        const raw = Buffer.from(outcome.SuccessValue, "base64").toString();
        return (raw === "" ? undefined : JSON.parse(raw)) as T;
      }
      if (outcome.SuccessReceiptId !== undefined) return undefined as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${method}: first receipt of ${txHash} never executed`);
}
