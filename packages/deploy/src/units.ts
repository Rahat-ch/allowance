/** USDC (6 decimals) and NEAR (24 decimals) amounts as atomic bigints. */

export const USDC_DECIMALS = 6;
export const NEAR_DECIMALS = 24;
export const NEAR = 10n ** 24n;
export const TGAS = 1_000_000_000_000n;

function parseDecimal(amount: string, decimals: number, unit: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match || (match[2] ?? "").length > decimals) {
    throw new Error(`not a ${unit} amount (at most ${decimals} decimals): ${JSON.stringify(amount)}`);
  }
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
}

function formatDecimal(atomic: bigint, decimals: number, minFraction: number): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const scale = 10n ** BigInt(decimals);
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(minFraction, "0");
  return `${sign}${abs / scale}${fraction ? `.${fraction}` : ""}`;
}

/** Parses `1.5` USDC into base units. Zero is allowed; callers decide whether it is valid. */
export function parseUsdc(amount: string): bigint {
  return parseDecimal(amount, USDC_DECIMALS, "USDC");
}

/** Formats base units as `1.500000`. */
export function formatUsdc(atomic: bigint): string {
  return formatDecimal(atomic, USDC_DECIMALS, USDC_DECIMALS);
}

/** Parses `0.5` NEAR into yoctoNEAR. */
export function parseNear(amount: string): bigint {
  return parseDecimal(amount, NEAR_DECIMALS, "NEAR");
}

/** Formats yoctoNEAR as `0.5` (trailing zeros trimmed). */
export function formatNear(yocto: bigint): string {
  return formatDecimal(yocto, NEAR_DECIMALS, 0);
}
