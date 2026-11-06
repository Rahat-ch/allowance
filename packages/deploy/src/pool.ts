/**
 * Sizing the Payer Account's key pool. Every outstanding Signed Payment leases one
 * derived key until its `max_block_height` passes, so the pool must exceed the Velocity
 * Limit multiplied by the longest lease (spec, "Key pool"). With fewer keys, Spend
 * Requests get the retryable "busy" error at the rate the Policy allows.
 */

/** The contract's bounds on `create_payer_account(key_count)`. */
export const MIN_KEY_COUNT = 1;
export const MAX_KEY_COUNT = 32;

/** Spec: about 1 block per second. Slower blocks would make leases longer. */
export const BLOCK_SECONDS = 1;

/** Blocks a lease is held beyond the payment's validity: funding and signing callbacks. */
export const LEASE_OVERHEAD_BLOCKS = 10;

export type PoolSizing = {
  /** Longest lease, in blocks: the Policy's `max_timeout_blocks` plus funding and signing. */
  leaseBlocks: number;
  /** Signed Payments outstanding at once when spending at the Velocity Limit. */
  concurrentAtVelocity: number;
  /** Fewest keys that exceed Velocity Limit x longest lease. */
  requiredKeys: number;
  /** Spends that could all be issued inside one lease if the Agent bursts. */
  burstKeys: number;
  verdict: "ok" | "warn" | "refuse";
  /** Why the verdict is not "ok". */
  message?: string;
};

export function poolSizing(input: { velocityLimit: number; maxTimeoutBlocks: number; keyCount: number }): PoolSizing {
  const { velocityLimit, maxTimeoutBlocks, keyCount } = input;
  const leaseBlocks = maxTimeoutBlocks + LEASE_OVERHEAD_BLOCKS;
  const concurrentAtVelocity = (velocityLimit * leaseBlocks * BLOCK_SECONDS) / 3600;
  // "Must exceed": strictly more keys than leases outstanding at the Velocity Limit.
  const requiredKeys = Math.max(MIN_KEY_COUNT, Math.floor(concurrentAtVelocity) + 1);
  const burstKeys = Math.min(velocityLimit, MAX_KEY_COUNT);
  const base = { leaseBlocks, concurrentAtVelocity, requiredKeys, burstKeys };

  if (!Number.isInteger(keyCount) || keyCount < MIN_KEY_COUNT || keyCount > MAX_KEY_COUNT) {
    return { ...base, verdict: "refuse", message: `keyCount must be an integer in ${MIN_KEY_COUNT}..${MAX_KEY_COUNT}` };
  }
  if (requiredKeys > MAX_KEY_COUNT) {
    return {
      ...base,
      verdict: "refuse",
      message:
        `a Velocity Limit of ${velocityLimit}/hour with leases of ${leaseBlocks} blocks needs more than ` +
        `${MAX_KEY_COUNT} keys (the contract's maximum); lower velocityLimit or maxTimeoutBlocks`,
    };
  }
  if (keyCount < requiredKeys) {
    return {
      ...base,
      verdict: "refuse",
      message:
        `keyCount ${keyCount} is too small: Velocity Limit ${velocityLimit}/hour x lease ${leaseBlocks} blocks ` +
        `(~${concurrentAtVelocity.toFixed(2)} payments outstanding) needs at least ${requiredKeys} keys`,
    };
  }
  if (keyCount < burstKeys) {
    return {
      ...base,
      verdict: "warn",
      message:
        `keyCount ${keyCount} covers spending at the Velocity Limit, but a burst of up to ${burstKeys} spends ` +
        `inside one ${leaseBlocks}-block lease would get the retryable "busy" error`,
    };
  }
  return { ...base, verdict: "ok" };
}
