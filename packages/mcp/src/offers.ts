/**
 * Choosing which x402 offer the Allowance pays, before any Spend Request is made.
 *
 * A seller's 402 lists offers (`accepts`). The Allowance can only pay an `exact` offer on
 * its own network, in its own asset (USDC). The Agent also caps what it is willing to pay
 * for one call (`max_usd`), and a resumed Request ID must be paid to the same Payee for
 * the same amount it was first requested with.
 */
import type { PaymentRequirements } from "@x402/core/types";

/** USDC has 6 decimals: amounts on the wire are base units ($1 = 1_000_000). */
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

export type OfferWanted = {
  /** CAIP-2 network the Allowance pays on, e.g. `near:testnet`. */
  network: string;
  /** The Allowance's asset (`get_asset`): the USDC contract. */
  asset: string;
  /** Most the Agent will pay for this call, in USDC base units. */
  maxAmount: bigint;
  /** For a resumed Request ID: the offer must match the request exactly. */
  request?: { payee: string; amount: bigint };
};

export type RefusalReason =
  /** No `exact` offer on the Allowance's network (e.g. only EVM or another scheme). */
  | "NoMatchingOffer"
  /** `exact` offers on the network, but none in the Allowance's asset. */
  | "AssetMismatch"
  /** A resumed request's Payee or amount is not offered any more. */
  | "RequestMismatch"
  /** Every usable offer costs more than `max_usd`. */
  | "OverMaxAmount";

export type OfferSummary = { scheme: string; network: string; asset: string; amount: string; pay_to: string };

export type OfferRefusal = { reason: RefusalReason; message: string; offers: OfferSummary[] };

export type OfferChoice = { ok: true; offer: PaymentRequirements } | { ok: false; refusal: OfferRefusal };

/**
 * Picks the cheapest offer the Allowance can pay within `wanted`, or explains why none
 * qualifies. Checks run network/scheme → asset → resumed request → max amount, so the
 * reason names the first thing that ruled every offer out.
 */
export function selectOffer(accepts: readonly PaymentRequirements[], wanted: OfferWanted): OfferChoice {
  const offers = accepts.map(summarize);
  const refuse = (reason: RefusalReason, message: string): OfferChoice => ({ ok: false, refusal: { reason, message, offers } });

  const onNetwork = accepts.filter((o) => o.scheme === "exact" && o.network === wanted.network);
  if (onNetwork.length === 0) {
    return refuse("NoMatchingOffer", `the seller offers no "exact" payment on ${wanted.network}`);
  }
  const inAsset = onNetwork.filter((o) => o.asset === wanted.asset && isBaseUnits(o.amount));
  if (inAsset.length === 0) {
    return refuse("AssetMismatch", `the seller does not accept ${wanted.asset}, the Allowance's asset`);
  }
  let candidates = inAsset;
  if (wanted.request) {
    const { payee, amount } = wanted.request;
    candidates = inAsset.filter((o) => o.payTo === payee && BigInt(o.amount) === amount);
    if (candidates.length === 0) {
      return refuse(
        "RequestMismatch",
        `the seller no longer offers ${formatUsd(amount)} to ${payee}, which this Request ID is bound to`,
      );
    }
  }
  const affordable = candidates.filter((o) => BigInt(o.amount) <= wanted.maxAmount);
  if (affordable.length === 0) {
    const cheapest = candidates.map((o) => BigInt(o.amount)).reduce((a, b) => (b < a ? b : a));
    return refuse("OverMaxAmount", `the price ${formatUsd(cheapest)} is over the max of ${formatUsd(wanted.maxAmount)}`);
  }
  const offer = affordable.reduce((a, b) => (BigInt(b.amount) < BigInt(a.amount) ? b : a));
  return { ok: true, offer };
}

/** True when two offers are the same payment terms (the x402 client may copy objects). */
export function sameOffer(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return a.scheme === b.scheme && a.network === b.network && a.asset === b.asset && a.payTo === b.payTo && a.amount === b.amount;
}

function summarize(o: PaymentRequirements): OfferSummary {
  return { scheme: o.scheme, network: o.network, asset: o.asset, amount: String(o.amount), pay_to: o.payTo };
}

function isBaseUnits(amount: unknown): amount is string {
  return typeof amount === "string" && /^\d{1,39}$/.test(amount);
}

/**
 * Dollars to USDC base units without float rounding: `"0.5"`, `"$0.50"` or `0.5` →
 * 500000n. At most 6 decimals.
 */
export function usdToBaseUnits(dollars: string | number): bigint {
  const text = typeof dollars === "number" ? numberToPlain(dollars) : dollars.trim().replace(/^\$/, "");
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error(`expected dollars with at most 6 decimals, like "0.50", got ${JSON.stringify(dollars)}`);
  return BigInt(match[1]!) * UNIT + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  // Enough digits for any 6-decimal amount, then drop trailing zeros.
  return n.toFixed(USDC_DECIMALS).replace(/\.?0+$/, "");
}

/** 1_250_000n → "$1.25"; 500n → "$0.0005". */
export function formatUsd(baseUnits: bigint | string): string {
  const v = BigInt(baseUnits);
  const whole = v / UNIT;
  const frac = (v % UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `$${whole}.${frac.padEnd(2, "0")}`;
}
