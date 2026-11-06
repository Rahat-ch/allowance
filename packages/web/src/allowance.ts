/**
 * The Owner page's data layer: read an Allowance through its views, and build the Owner
 * calls the wallet signs. No UI and no wallet here, so it is tested on its own (unit
 * tests for the builders, a sandbox test for the views against the real contract).
 *
 * Amounts come back as bigint USDC base units (6 decimals). Timestamps stay as chain
 * nanoseconds in a `number`: JSON loses sub-microsecond precision, which display ignores.
 */
import { JsonRpcProvider } from "@near-js/providers";

// ---- what the contract returns --------------------------------------------------------

/** Where a Spend Request is in its lifecycle (the contract's `Status`). */
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

export type Outcome = "Approved" | "Pending" | "Blocked";

export type SpendRequest = {
  requestId: string;
  payee: string;
  /** USDC base units. */
  amount: bigint;
  memo: string | null;
  outcome: Outcome;
  status: Status;
  blockedReason: string | null;
  requestedAtNs: number;
  /** When a Pending spend Expires (ns). */
  expiresAtNs: number | null;
  /** When an approved spend Lapses unless the Agent picks it up (ns). */
  pickupDeadlineNs: number | null;
};

export type Budget = {
  /** Reserved against the Daily Cap in the rolling 24 hours, Reservations included. */
  usedInWindow: bigint;
  dailyCap: bigint;
  available: bigint;
  /** When the oldest Reservation in the window falls out of it (ns); null if none. */
  nextReleaseNs: number | null;
  velocityUsed: number;
  velocityLimit: number;
  usdcBalance: bigint;
  /** Pending + approved-unsigned amounts. */
  held: bigint;
  /** USDC balance − Held: what the Owner may Withdraw. */
  withdrawable: bigint;
  /** yoctoNEAR on the Allowance account. */
  nearBalance: bigint;
};

export type Policy = {
  dailyCap: bigint;
  autoLimit: bigint;
  hardCeiling: bigint;
  velocityLimit: number;
  maxTimeoutBlocks: number;
};

/** Everything the page shows, read in one go. */
export type Snapshot = {
  owner: string;
  paused: boolean;
  revoked: boolean;
  budget: Budget;
  policy: Policy;
  allowlist: string[];
  /** Pending and approved-but-not-picked-up spends, oldest first. */
  pending: SpendRequest[];
};

// Raw JSON shapes (u128 as strings, u64 as numbers).
type RawSpendRequest = {
  request_id: string;
  payee: string;
  amount: string;
  memo: string | null;
  outcome: Outcome;
  status: Status;
  blocked_reason: string | null;
  requested_at_ns: number;
  expires_at_ns: number | null;
  pickup_deadline_ns: number | null;
};

type RawBudget = {
  used_in_window: string;
  daily_cap: string;
  available: string;
  next_release_ns: number | null;
  velocity_used: number;
  velocity_limit: number;
  usdc_balance: string;
  held: string;
  withdrawable: string;
  near_balance: string;
};

type RawPolicy = {
  daily_cap: string;
  auto_limit: string;
  hard_ceiling: string;
  velocity_limit: number;
  max_timeout_blocks: number;
};

export function parseSpendRequest(r: RawSpendRequest): SpendRequest {
  return {
    requestId: r.request_id,
    payee: r.payee,
    amount: BigInt(r.amount),
    memo: r.memo,
    outcome: r.outcome,
    status: r.status,
    blockedReason: r.blocked_reason,
    requestedAtNs: r.requested_at_ns,
    expiresAtNs: r.expires_at_ns,
    pickupDeadlineNs: r.pickup_deadline_ns,
  };
}

export function parseBudget(b: RawBudget): Budget {
  return {
    usedInWindow: BigInt(b.used_in_window),
    dailyCap: BigInt(b.daily_cap),
    available: BigInt(b.available),
    nextReleaseNs: b.next_release_ns,
    velocityUsed: b.velocity_used,
    velocityLimit: b.velocity_limit,
    usdcBalance: BigInt(b.usdc_balance),
    held: BigInt(b.held),
    withdrawable: BigInt(b.withdrawable),
    nearBalance: BigInt(b.near_balance),
  };
}

export function parsePolicy(p: RawPolicy): Policy {
  return {
    dailyCap: BigInt(p.daily_cap),
    autoLimit: BigInt(p.auto_limit),
    hardCeiling: BigInt(p.hard_ceiling),
    velocityLimit: p.velocity_limit,
    maxTimeoutBlocks: p.max_timeout_blocks,
  };
}

// ---- views ----------------------------------------------------------------------------

/** Read-only access to one Allowance over JSON-RPC. */
export class AllowanceViews {
  private readonly provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    readonly allowanceId: string,
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  private async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction(this.allowanceId, method, args)) as T;
  }

  getOwner(): Promise<string> {
    return this.view<string>("get_owner");
  }

  isPaused(): Promise<boolean> {
    return this.view<boolean>("is_paused");
  }

  isRevoked(): Promise<boolean> {
    return this.view<boolean>("is_revoked");
  }

  async getBudget(): Promise<Budget> {
    return parseBudget(await this.view<RawBudget>("get_budget"));
  }

  async getPolicy(): Promise<Policy> {
    return parsePolicy(await this.view<RawPolicy>("get_policy"));
  }

  getAllowlist(): Promise<string[]> {
    return this.view<string[]>("get_allowlist");
  }

  async getRequest(requestId: string): Promise<SpendRequest | null> {
    const r = await this.view<RawSpendRequest | null>("get_request", { request_id: requestId });
    return r ? parseSpendRequest(r) : null;
  }

  /** Every live Pending and approved-unsigned spend, oldest first (pages through all). */
  async listPending(): Promise<SpendRequest[]> {
    const page = 100;
    const all: SpendRequest[] = [];
    for (let from = 0; ; from += page) {
      const batch = await this.view<RawSpendRequest[]>("list_pending", { from_index: from, limit: page });
      all.push(...batch.map(parseSpendRequest));
      if (batch.length < page) return all;
    }
  }

  async snapshot(): Promise<Snapshot> {
    const [owner, paused, revoked, budget, policy, allowlist, pending] = await Promise.all([
      this.getOwner(),
      this.isPaused(),
      this.isRevoked(),
      this.getBudget(),
      this.getPolicy(),
      this.getAllowlist(),
      this.listPending(),
    ]);
    return { owner, paused, revoked, budget, policy, allowlist, pending };
  }
}

// ---- Owner calls ----------------------------------------------------------------------

/**
 * One Owner method call on the Allowance, ready for a wallet to sign. `deposit` is in
 * yoctoNEAR; "1" is the confirmation the contract demands for every call that loosens
 * control or moves funds (a wallet must confirm it; a sign-in key can't attach it).
 */
export type OwnerCall = {
  methodName: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
};

const TGAS = 1_000_000_000_000n;
const ONE_YOCTO = 1n;

function call(methodName: string, args: Record<string, unknown>, deposit: bigint, gas = 30n * TGAS): OwnerCall {
  return { methodName, args, gas, deposit };
}

export const ownerCalls = {
  approve: (requestId: string) => call("approve", { request_id: requestId }, ONE_YOCTO),
  reject: (requestId: string) => call("reject", { request_id: requestId }, ONE_YOCTO),
  /** Stopping the Agent needs no confirmation deposit, so it is as quick as possible. */
  pause: () => call("pause", {}, 0n),
  unpause: () => call("unpause", {}, ONE_YOCTO),
  /** Cancels every open spend and deletes the Agent's key: give it room. */
  revoke: () => call("revoke", {}, ONE_YOCTO, 100n * TGAS),
} as const;

// ---- errors ---------------------------------------------------------------------------

/** Contract panics the Owner can hit, in the words the page shows. */
const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/request already decided/, "This spend was already decided. The list has been refreshed."],
  [/request expired/, "This spend Expired (24 hours without a decision) and can no longer be decided."],
  [/request lapsed/, "This approval Lapsed: the Agent didn't pick it up within 1 hour."],
  [/request was blocked/, "This Spend Request was Blocked and can't be decided."],
  [/unknown request/, "No such Spend Request on this Allowance."],
  [/request no longer qualifies: UnknownPayee/, "Can't approve: the Payee is no longer on the Allowlist."],
  [/request no longer qualifies: OverHardCeiling/, "Can't approve: the amount is now above the Hard Ceiling."],
  [/only the Owner/, "Only the Owner of this Allowance can do that. Sign in with the Owner's account."],
  [/the Agent is already revoked/, "The Agent is already revoked."],
  [/the Agent is revoked/, "The Agent is revoked; that can't be undone."],
  [/method is not found|MethodNotFound|CodeDoesNotExist|contract is not deployed|no contract code/i, "This account isn't an Allowance (no Allowance contract with these views is deployed there)."],
  [/does not exist while viewing|UNKNOWN_ACCOUNT|AccountDoesNotExist/i, "No such account on this network."],
  [/exactly 1 yoctoNEAR/i, "This action needs a wallet confirmation (1 yoctoNEAR). Approve it in your wallet."],
];

/** A readable message for a failed view or Owner call. */
export function explainError(error: unknown): string {
  const text = errorText(error);
  for (const [pattern, message] of KNOWN_ERRORS) if (pattern.test(text)) return message;
  if (/user (rejected|cancel)|closed the window|cancelled/i.test(text)) return "Cancelled in the wallet.";
  return text || "Something went wrong.";
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : ` ${errorText(error.cause)}`;
    return `${error.message}${cause}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
