/**
 * NEAR testnet access for the tracer scripts: an RPC provider with fallback,
 * accounts signed by local keys, and the few token/contract calls the scripts
 * need. The RPC is chosen on first use, so importing this module (e.g. from a
 * test) makes no network calls.
 */
import { Account, JsonRpcProvider, type SerializedReturnValue } from "near-api-js";
import { RPC_URLS, USDC_TESTNET, readAccountKey, type KeyPairString } from "./config.js";

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const NEAR = 10n ** 24n;
/** USDC testnet `storage_balance_bounds`: min = max = 0.00125 NEAR. */
export const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/**
 * True for FastNEAR endpoints. rpc.testnet.near.org is about 4x slower, which
 * can outlast a 60-block Signed Payment (docs/notes/chain-signatures.md).
 */
export function isFastRpc(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "fastnear.com" || host.endsWith(".fastnear.com");
}

export type Rpc = { url: string; provider: JsonRpcProvider };

let connection: Promise<Rpc> | undefined;

/**
 * The first RPC URL that answers. Chosen once per run rather than with
 * near-api-js's FailoverRpcProvider, which also fails over (and wraps) plain
 * handler errors such as "account does not exist" or a contract panic.
 */
export function rpc(): Promise<Rpc> {
  connection ??= connect();
  return connection;
}

async function connect(): Promise<Rpc> {
  for (const url of RPC_URLS) {
    try {
      const provider = new JsonRpcProvider({ url });
      await provider.viewBlock({ finality: "final" });
      if (!isFastRpc(url)) console.warn(`warning: using the slow fallback RPC ${url}`);
      return { url, provider };
    } catch {
      console.warn(`RPC ${url} did not answer, trying the next one`);
    }
  }
  throw new Error(`no testnet RPC answered: ${RPC_URLS.join(", ")}`);
}

export async function provider(): Promise<JsonRpcProvider> {
  return (await rpc()).provider;
}

/** An account signing with its key from `~/.near-credentials/testnet/<id>.json`. */
export async function accountFromCredentials(accountId: string): Promise<Account> {
  return new Account(accountId, await provider(), readAccountKey(accountId));
}

export async function accountWithKey(accountId: string, secretKey: KeyPairString): Promise<Account> {
  return new Account(accountId, await provider(), secretKey);
}

/** A view call; `T` is the caller's claim about the contract's JSON result. */
export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await (await provider()).callFunction<SerializedReturnValue>({ contractId, method, args })) as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await (await provider()).viewAccount({ accountId });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "AccountDoesNotExistError") return false;
    throw error;
  }
}

/** True when the account holds any contract storage. */
export async function hasContractState(accountId: string): Promise<boolean> {
  try {
    const { values } = await (await provider()).viewContractState({ contractId: accountId, prefix: "" });
    return values.length > 0;
  } catch (error) {
    if (error instanceof Error && error.name === "TooLargeContractStateError") return true;
    throw error;
  }
}

/**
 * `EXPERIMENTAL_tx_status` for a transaction already included in a final block:
 * returns at once with the receipt outcomes known so far.
 */
export async function txStatus(txHash: string, senderId: string) {
  return (await provider()).viewTransactionStatusWithReceipts({
    txHash,
    accountId: senderId,
    waitUntil: "INCLUDED_FINAL",
  });
}

export async function usdcBalance(accountId: string): Promise<bigint> {
  return BigInt(await view<string>(USDC_TESTNET, "ft_balance_of", { account_id: accountId }));
}

export async function isUsdcRegistered(accountId: string): Promise<boolean> {
  return (await view<object | null>(USDC_TESTNET, "storage_balance_of", { account_id: accountId })) !== null;
}

/** `storage_deposit` on USDC for `accountId`, paid by `payer`. No-op if already registered. */
export async function registerUsdc(payer: Account, accountId: string): Promise<boolean> {
  if (await isUsdcRegistered(accountId)) return false;
  await payer.callFunction({
    contractId: USDC_TESTNET,
    methodName: "storage_deposit",
    args: { account_id: accountId, registration_only: true },
    deposit: USDC_STORAGE_DEPOSIT,
    gas: 30n * TGAS,
  });
  return true;
}
