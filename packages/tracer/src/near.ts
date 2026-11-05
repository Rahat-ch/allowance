/**
 * NEAR testnet access for the tracer scripts: an RPC provider with fallback,
 * accounts signed by local keys, and the few token/contract calls the scripts
 * need.
 */
import { Account, JsonRpcProvider, type SerializedReturnValue } from "near-api-js";
import { RPC_URLS, USDC_TESTNET, readAccountKey, type KeyPairString } from "./config.js";

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const NEAR = 10n ** 24n;
/** USDC testnet `storage_balance_bounds`: min = max = 0.00125 NEAR. */
export const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/**
 * The first RPC URL that answers. Chosen once per run rather than with
 * near-api-js's FailoverRpcProvider, which also fails over (and wraps) plain
 * handler errors such as "account does not exist" or a contract panic.
 */
async function liveRpcUrl(): Promise<string> {
  for (const url of RPC_URLS) {
    try {
      await new JsonRpcProvider({ url }).viewBlock({ finality: "final" });
      return url;
    } catch {
      console.warn(`RPC ${url} did not answer, trying the next one`);
    }
  }
  throw new Error(`no testnet RPC answered: ${RPC_URLS.join(", ")}`);
}

export const rpcUrl = await liveRpcUrl();
export const provider = new JsonRpcProvider({ url: rpcUrl });

/** An account signing with its key from `~/.near-credentials/testnet/<id>.json`. */
export function accountFromCredentials(accountId: string): Account {
  return new Account(accountId, provider, readAccountKey(accountId));
}

export function accountWithKey(accountId: string, secretKey: KeyPairString): Account {
  return new Account(accountId, provider, secretKey);
}

/** A view call; `T` is the caller's claim about the contract's JSON result. */
export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction<SerializedReturnValue>({ contractId, method, args })) as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "AccountDoesNotExistError") return false;
    throw error;
  }
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
