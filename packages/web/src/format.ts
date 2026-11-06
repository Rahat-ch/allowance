/** Display formatting for the Owner page. Pure functions, no DOM. */

/** USDC has 6 decimals: 1 USDC = 1_000_000 base units. */
export const USDC_DECIMALS = 6;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);
const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * USDC base units as dollars: `15000000n` → `"$15.00"`, `1234567n` → `"$1.234567"`.
 * Always shows cents; shows more digits only when they aren't zero, so nothing is hidden.
 */
export function formatUsdc(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / USDC_UNIT;
  let fraction = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${negative ? "-" : ""}$${groupThousands(whole.toString())}.${fraction}`;
}

/** Dollars typed by a person (`"15"`, `"$1,000.50"`) as USDC base units; null if invalid. */
export function parseUsdc(input: string): bigint | null {
  const cleaned = input.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(cleaned);
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** NEAR typed by a person (`"1"`, `"0.25"`) as yoctoNEAR; null if invalid. */
export function parseNear(input: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{0,24}))?$/.exec(input.trim().replaceAll(",", ""));
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, "0"));
}

/** USDC base units as a plain number for an input field: `12500000n` → `"12.5"`. */
export function usdcInput(baseUnits: bigint): string {
  const fraction = (baseUnits % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${baseUnits / USDC_UNIT}${fraction ? `.${fraction}` : ""}`;
}

/** yoctoNEAR as NEAR with up to 4 decimals, rounded down: `"2.5 NEAR"`. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = ((yocto % YOCTO_PER_NEAR) * 10_000n) / YOCTO_PER_NEAR;
  const digits = fraction.toString().padStart(4, "0").replace(/0+$/, "");
  return `${groupThousands(whole.toString())}${digits ? `.${digits}` : ""} NEAR`;
}

/**
 * A span of time, coarse enough to read at a glance: `"45s"`, `"12m"`, `"3h 5m"`,
 * `"2d 4h"`. Negative or zero spans read `"0s"`.
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** How long until a chain timestamp (ns): `"in 3h 5m"`, or `"now"` once it has passed. */
export function timeUntil(targetNs: number, nowMs: number): string {
  const ms = targetNs / 1e6 - nowMs;
  return ms <= 0 ? "now" : `in ${formatDuration(ms)}`;
}

/** How long ago a chain timestamp (ns) was: `"5m ago"`. */
export function timeAgo(ns: number, nowMs: number): string {
  const ms = nowMs - ns / 1e6;
  return ms < 1000 ? "just now" : `${formatDuration(ms)} ago`;
}

/** A chain timestamp (ns) as local date and time. */
export function formatTimestamp(ns: number): string {
  return new Date(ns / 1e6).toLocaleString();
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
