/** USDC amounts: 6 decimals, handled as atomic bigint units. */

/** Formats atomic USDC as `1.234567`. */
export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Parses `1.5` USDC into atomic units, refusing more than 6 decimals. */
export function parseUsdc(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) throw new Error(`not a USDC amount (max 6 decimals): ${amount}`);
  const atomic = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (atomic === 0n) throw new Error("amount must be positive");
  return atomic;
}
