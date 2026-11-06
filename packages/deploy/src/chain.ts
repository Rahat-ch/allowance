/**
 * The few chain reads the deploy needs, over one RPC endpoint chosen at connect time.
 */
import { JsonRpcProvider, type SerializedReturnValue } from "near-api-js";
import type { AccessKeyInfo } from "./lock.js";

export type Chain = {
  rpcUrl: string;
  provider: JsonRpcProvider;
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  accountExists(accountId: string): Promise<boolean>;
  /** Total balance and what storage locks, in yoctoNEAR. */
  balance(accountId: string): Promise<{ total: bigint; storageLocked: bigint; codeHash: string }>;
  accessKeys(accountId: string): Promise<AccessKeyInfo[]>;
};

/** yoctoNEAR per byte of storage (protocol storage_amount_per_byte). */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/**
 * The first RPC URL that answers, used for the whole run. Not near-api-js's
 * FailoverRpcProvider: it also fails over (and wraps) plain errors such as "account
 * does not exist" or a contract panic.
 */
export async function connect(rpcUrls: readonly string[], warn: (line: string) => void = console.warn): Promise<Chain> {
  for (const [i, url] of rpcUrls.entries()) {
    try {
      const provider = new JsonRpcProvider({ url });
      await provider.viewBlock({ finality: "final" });
      if (i > 0) warn(`warning: using the fallback RPC ${url}`);
      return chainFor(url, provider);
    } catch {
      warn(`RPC ${url} did not answer, trying the next one`);
    }
  }
  throw new Error(`no RPC answered: ${rpcUrls.join(", ")}`);
}

export function chainFor(rpcUrl: string, provider: JsonRpcProvider): Chain {
  return {
    rpcUrl,
    provider,
    async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      return (await provider.callFunction<SerializedReturnValue>({ contractId, method, args })) as T;
    },
    async accountExists(accountId: string): Promise<boolean> {
      try {
        await provider.viewAccount({ accountId });
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "AccountDoesNotExistError") return false;
        throw error;
      }
    },
    async balance(accountId: string) {
      const account = await provider.viewAccount({ accountId });
      return {
        total: BigInt(account.amount),
        storageLocked: BigInt(account.storage_usage) * STORAGE_PRICE_PER_BYTE,
        codeHash: account.code_hash,
      };
    },
    async accessKeys(accountId: string): Promise<AccessKeyInfo[]> {
      return (await provider.viewAccessKeyList({ accountId })).keys as AccessKeyInfo[];
    },
  };
}
