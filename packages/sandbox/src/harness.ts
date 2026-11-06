/**
 * Seam 2 harness: a throwaway NEAR sandbox with
 *  - a mock USDC (NEP-141) token,
 *  - a mock Chain Signatures signer with the real `sign` interface and
 *    yield/resume behaviour (the test decides when, and whether, it answers),
 *  - an Allowance whose Payer Account the contract creates with keys "derived"
 *    by the mock signer,
 *  - the official x402 NEAR facilitator in process, with a relayer account.
 *
 * Accounts are sub-accounts of the sandbox's genesis account.
 */
import { Account, JsonRpcProvider, KeyPair, type SerializedReturnValue } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { NEAR_TESTNET_CAIP2 } from "@x402/near";
import { readContracts, type Wasms } from "./contracts.js";
import { createFacilitator, type Facilitator } from "./facilitator.js";

export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;
export const USDC = 1_000_000n;
/** Mock USDC uses the same storage deposit as Circle USDC. */
export const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** The x402 network the facilitator and seller speak; the RPC behind it is the sandbox. */
export const NETWORK = NEAR_TESTNET_CAIP2;
/** Chain Signatures' Ed25519 domain. */
export const ED25519_DOMAIN_ID = 1;

type KeyPairString = `ed25519:${string}`;

export type PendingSignature = {
  id: number;
  predecessor: string;
  path: string;
  payload_hex: string;
  domain_id: number;
};

/** The Policy as the contract takes it: amounts are USDC base units as strings. */
export type Policy = {
  daily_cap: string;
  auto_limit: string;
  hard_ceiling: string;
  velocity_limit: number;
  max_timeout_blocks: number;
};

/** Roomy defaults so tests that aren't about limits never hit one. */
export const DEFAULT_POLICY: Policy = {
  daily_cap: (1_000n * USDC).toString(),
  auto_limit: (100n * USDC).toString(),
  hard_ceiling: (500n * USDC).toString(),
  velocity_limit: 1_000,
  max_timeout_blocks: 600,
};

export type HarnessOptions = {
  /** The Allowance's Policy (default: DEFAULT_POLICY). */
  policy?: Policy;
  /** Put the Payee on the Allowlist (default true). */
  allowPayee?: boolean;
  /** Derived keys the Payer Account is created with. */
  payerKeys?: number;
  /** Answer every signature request as soon as it appears. Tests of timeouts turn this off. */
  autoRespond?: boolean;
  /** USDC the Owner deposits into the Allowance (ft_transfer_call), in base units. */
  allowanceUsdc?: bigint;
  /** Wasm to deploy; defaults to the last build (see buildContracts). */
  wasms?: Wasms;
};

export type Harness = Awaited<ReturnType<typeof setUp>>;

/** Starts a sandbox and sets everything up; a failed setup still stops the sandbox. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const sandbox = await Sandbox.start({});
  try {
    return await setUp(sandbox, options);
  } catch (error) {
    await sandbox.tearDown();
    throw error;
  }
}

async function setUp(sandbox: Sandbox, options: HarnessOptions) {
  const { payerKeys = 2, autoRespond = true, allowanceUsdc = 100n * USDC, policy = DEFAULT_POLICY, allowPayee = true } = options;
  const wasms = options.wasms ?? readContracts();
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const secrets = new Map<string, KeyPairString>();
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);

  async function createAccount(prefix: string, near: bigint): Promise<Account> {
    const accountId = `${prefix}.${root.accountId}`;
    const key = KeyPair.fromRandom("ed25519");
    await root.createSubAccount({ accountOrPrefix: accountId, publicKey: key.getPublicKey(), nearToTransfer: near * NEAR });
    secrets.set(accountId, key.toString() as KeyPairString);
    return new Account(accountId, provider, key.toString() as KeyPairString);
  }

  const [usdc, signer, owner, allowance, relayer, payee] = await Promise.all([
    createAccount("usdc", 10n),
    createAccount("signer", 10n),
    createAccount("owner", 50n),
    createAccount("allowance", 50n),
    createAccount("relayer", 20n),
    createAccount("payee", 5n),
  ]);
  const payerAccountId = `pay.${allowance.accountId}`;

  await Promise.all([
    usdc.deployContract(wasms.usdc),
    signer.deployContract(wasms.signer),
    allowance.deployContract(wasms.allowance),
  ]);
  await signer.callFunction({ contractId: signer.accountId, methodName: "new", args: {} });
  await usdc.callFunction({
    contractId: usdc.accountId,
    methodName: "new",
    args: { owner_id: owner.accountId, total_supply: (1_000_000n * USDC).toString() },
  });
  const agentKey = KeyPair.fromRandom("ed25519");
  await allowance.callFunction({
    contractId: allowance.accountId,
    methodName: "new",
    args: {
      owner_id: owner.accountId,
      asset_id: usdc.accountId,
      signer_id: signer.accountId,
      domain_id: ED25519_DOMAIN_ID,
      agent_public_key: agentKey.getPublicKey().toString(),
      policy,
      // Sandbox gas is ~10x testnet's price, so give the Agent's key plenty.
      agent_allowance: (20n * NEAR).toString(),
    },
  });
  // The Agent: a function-call key on the Allowance account that may only call request_spend.
  const agent = new Account(allowance.accountId, provider, agentKey.toString() as KeyPairString);

  // Keys the mock signer hands out as "derived" from the Allowance. Only the
  // harness holds their secrets, standing in for the MPC network.
  const derivedKeys = Array.from({ length: payerKeys }, () => KeyPair.fromRandom("ed25519"));
  const keyByPath = new Map<string, KeyPair>();
  for (const [i, key] of derivedKeys.entries()) {
    const path = `x402/${i}`;
    keyByPath.set(`${allowance.accountId}|${path}`, key);
    await root.callFunction({
      contractId: signer.accountId,
      methodName: "register_derived_key",
      args: { predecessor: allowance.accountId, path, public_key: key.getPublicKey().toString() },
    });
  }

  async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await provider.callFunction<SerializedReturnValue>({ contractId, method, args })) as T;
  }

  async function registerUsdc(accountId: string): Promise<void> {
    await owner.callFunction({
      contractId: usdc.accountId,
      methodName: "storage_deposit",
      args: { account_id: accountId, registration_only: true },
      deposit: USDC_STORAGE_DEPOSIT,
      gas: 30n * TGAS,
    });
  }

  async function transferUsdc(from: Account, to: string, amount: bigint): Promise<void> {
    await from.callFunction({
      contractId: usdc.accountId,
      methodName: "ft_transfer",
      args: { receiver_id: to, amount: amount.toString() },
      deposit: 1n,
      gas: 30n * TGAS,
    });
  }

  /** Funds the Allowance the way an Owner does: transfer-and-notify, so the deposit is credited. */
  async function depositUsdc(from: Account, amount: bigint): Promise<void> {
    await from.callFunction({
      contractId: usdc.accountId,
      methodName: "ft_transfer_call",
      args: { receiver_id: allowance.accountId, amount: amount.toString(), msg: "" },
      deposit: 1n,
      gas: 60n * TGAS,
    });
  }

  async function usdcBalance(accountId: string): Promise<bigint> {
    return BigInt(await view<string>(usdc.accountId, "ft_balance_of", { account_id: accountId }));
  }

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(sandbox.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }

  async function addPayee(accountId: string): Promise<void> {
    await owner.callFunction({ contractId: allowance.accountId, methodName: "add_payee", args: { payee: accountId } });
  }

  async function finalHeight(): Promise<number> {
    return (await provider.viewBlock({ finality: "final" })).header.height;
  }

  /** Produces `blocks` blocks at once, e.g. to run out a signature request's yield timeout. */
  async function fastForward(blocks: number): Promise<void> {
    await rpc("sandbox_fast_forward", { delta_height: blocks });
  }

  // ---- the mock signer, driven by the test ------------------------------------------

  async function pendingSignatures(): Promise<PendingSignature[]> {
    return view<PendingSignature[]>(signer.accountId, "pending_requests");
  }

  /** The signature the MPC network would produce for `request`. */
  function signatureFor(request: PendingSignature): Uint8Array {
    const key = keyByPath.get(`${request.predecessor}|${request.path}`);
    if (!key) throw new Error(`no derived key for ${request.predecessor} ${request.path}`);
    return key.sign(Buffer.from(request.payload_hex, "hex")).signature;
  }

  /** Delivers a signature; resolves to whether it reached the waiting caller (false once timed out). */
  async function respond(id: number, signature: Uint8Array): Promise<boolean> {
    return (await root.callFunction({
      contractId: signer.accountId,
      methodName: "respond",
      args: { id, signature: Array.from(signature) },
      gas: 100n * TGAS,
    })) as boolean;
  }

  async function respondToAll(): Promise<number> {
    const pending = await pendingSignatures();
    await Promise.all(pending.map((request) => respond(request.id, signatureFor(request))));
    return pending.length;
  }

  // The automatic responder stands in for a healthy MPC network. Its errors are kept
  // and rethrown by `assertResponderHealthy` (waits call it) instead of being swallowed.
  let responder: Promise<void> | undefined;
  let responding = false;
  let responderError: unknown;
  function startResponder(): void {
    responding = true;
    responder ??= (async () => {
      while (responding) {
        try {
          await respondToAll();
        } catch (error) {
          if (responding) responderError ??= error;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      responder = undefined;
    })();
  }

  async function stopResponder(): Promise<void> {
    responding = false;
    await responder;
  }

  function assertResponderHealthy(): void {
    if (responderError !== undefined) throw new Error("mock signer responder failed", { cause: responderError });
  }

  /**
   * Calls `method` and resolves with the first receipt's return value once it has
   * executed, without waiting for the callbacks it scheduled (signing can take a while).
   * A panic in the method rejects with its message.
   */
  async function callNow<T>(account: Account, contractId: string, method: string, args: Record<string, unknown>, gas = 300n * TGAS): Promise<T> {
    const tx = await account.callFunctionRaw({ contractId, methodName: method, args, gas, waitUntil: "INCLUDED_FINAL" });
    const txHash = tx.transaction_outcome.id;
    const receiptId = tx.transaction_outcome.outcome.receipt_ids[0];
    for (let i = 0; i < 200; i++) {
      const status = await provider.viewTransactionStatusWithReceipts({ txHash, accountId: account.accountId, waitUntil: "INCLUDED" });
      const outcome = status.receipts_outcome.find((r) => r.id === receiptId)?.outcome.status as
        | { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown }
        | string
        | undefined;
      if (outcome !== undefined && typeof outcome === "object") {
        if (outcome.Failure !== undefined) throw new Error(`${method} failed: ${JSON.stringify(outcome.Failure)}`);
        if (outcome.SuccessValue !== undefined) {
          const raw = Buffer.from(outcome.SuccessValue, "base64").toString();
          return (raw === "" ? undefined : JSON.parse(raw)) as T;
        }
        if (outcome.SuccessReceiptId !== undefined) return undefined as T;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${method}: first receipt of ${txHash} never executed`);
  }

  // ---- Payer Account ----------------------------------------------------------------

  await owner.callFunction({
    contractId: allowance.accountId,
    methodName: "create_payer_account",
    args: { key_count: payerKeys },
    gas: 300n * TGAS,
  });
  const keys = await view<string[]>(allowance.accountId, "payer_keys");
  if (keys.length !== payerKeys) throw new Error(`Payer Account has ${keys.length} recorded keys, expected ${payerKeys}`);

  await Promise.all([registerUsdc(allowance.accountId), registerUsdc(payee.accountId)]);
  if (allowPayee) await addPayee(payee.accountId);
  if (allowanceUsdc > 0n) await depositUsdc(owner, allowanceUsdc);

  const facilitator: Facilitator = createFacilitator({
    relayer: { accountId: relayer.accountId, secretKey: secrets.get(relayer.accountId)! },
    rpcUrl: sandbox.rpcUrl,
  });

  if (autoRespond) startResponder();

  async function stop(): Promise<void> {
    await stopResponder();
    await sandbox.tearDown();
  }

  return {
    rpcUrl: sandbox.rpcUrl,
    provider,
    root,
    usdc,
    signer,
    owner,
    allowance,
    agent,
    policy,
    addPayee,
    relayer,
    payee,
    payerAccountId,
    derivedKeys,
    facilitator,
    createAccount,
    view,
    registerUsdc,
    transferUsdc,
    depositUsdc,
    usdcBalance,
    finalHeight,
    fastForward,
    pendingSignatures,
    signatureFor,
    respond,
    respondToAll,
    startResponder,
    stopResponder,
    assertResponderHealthy,
    callNow,
    stop,
  };
}
