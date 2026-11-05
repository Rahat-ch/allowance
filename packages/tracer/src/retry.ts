/** Retrying flaky RPC reads with exponential backoff. */

export type RetryOptions = {
  /** Total tries, including the first. */
  attempts: number;
  /** Delay before the first retry; doubles on each further retry. */
  baseDelayMs: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Calls `fn` until it resolves or `attempts` run out, then rethrows the last error. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs = Number.POSITIVE_INFINITY, onRetry } = options;
  const wait = options.sleep ?? sleep;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got ${attempts}`);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      onRetry?.(error, attempt, delayMs);
      await wait(delayMs);
    }
  }
}
