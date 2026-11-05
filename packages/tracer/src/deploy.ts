/**
 * `pnpm --filter tracer run deploy [-- --force]`: sets up an Allowance on testnet for the tracer.
 *
 *   1. creates `allowance.<OWNER_ACCOUNT_ID>` with 5 NEAR
 *   2. builds the contract (`cargo near build non-reproducible-wasm`, incremental)
 *      and deploys it. Refuses to replace different code on an account that
 *      already holds contract state unless `--force` is passed
 *   3. calls `new` (signer v1.signer-prod.testnet, Ed25519 domain 1) if the
 *      contract is not initialized yet
 *   4. adds the Agent's function-call key (tracer_sign only, 1 NEAR gas
 *      allowance), or checks that the existing one has exactly that permission
 *   5. registers the Allowance for USDC storage
 *   6. calls `create_payer_account({key_count: 4})` as the Owner, then checks the
 *      Payer Account exists, its keys are recorded and it is USDC-registered
 *   7. writes ALLOWANCE_ACCOUNT_ID and AGENT_KEY_FILE to .env
 *
 * Each step is skipped when already done, so it is safe to re-run.
 *
 * Keys go to ~/.near-credentials/testnet only. The tracer keeps the deployer's
 * full-access key on the Allowance so it can be redeployed; a real Allowance
 * must hold none (ADR 0004).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, baseEncode, type Account } from "near-api-js";
import { payerAccountId, payerKeys } from "./allowance.js";
import {
  CREDENTIALS_DIR,
  MPC_ED25519_DOMAIN_ID,
  MPC_SIGNER_ID,
  REPO_ROOT,
  USDC_TESTNET,
  accountKeyFile,
  accountLink,
  ensureCredentialsDir,
  isMain,
  loadEnv,
  readKeyFile,
  requireEnv,
  setEnvValue,
  txLink,
  writeKeyFile,
  type KeyPairString,
} from "./config.js";
import {
  NEAR,
  TGAS,
  accountExists,
  accountFromCredentials,
  accountWithKey,
  hasContractState,
  isUsdcRegistered,
  provider,
  registerUsdc,
} from "./near.js";

const WASM = join(REPO_ROOT, "target", "near", "allowance", "allowance.wasm");
const CONTRACT_DIR = join(REPO_ROOT, "contracts", "allowance");
const ALLOWANCE_BALANCE = 5n * NEAR;
const AGENT_GAS_ALLOWANCE = 1n * NEAR;
const AGENT_METHOD = "tracer_sign";
const PAYER_KEY_COUNT = 4;
const CREATE_PAYER_DEPOSIT = 1n * NEAR;
/** `code_hash` of an account with no contract. */
const EMPTY_CODE_HASH = "11111111111111111111111111111111";

const USAGE = "usage: pnpm --filter tracer run deploy [-- --force]";

export function parseDeployArgs(argv: readonly string[]): { force: boolean } {
  let force = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--force") force = true;
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return { force };
}

export type DeployDecision = { action: "skip" } | { action: "deploy" } | { action: "refuse"; reason: string };

/** Whether to deploy `built` over what `accountId` runs now. */
export function deployDecision(input: {
  accountId: string;
  deployed: string;
  built: string;
  hasState: boolean;
  force: boolean;
}): DeployDecision {
  const { accountId, deployed, built, hasState, force } = input;
  if (deployed === built) return { action: "skip" };
  if (deployed === EMPTY_CODE_HASH || !hasState || force) return { action: "deploy" };
  return {
    action: "refuse",
    reason:
      `${accountId} runs code ${deployed} and already holds contract state. Deploying ${built} over it ` +
      `keeps that state, which the new code may not be able to read (the contract has no migration), ` +
      `and existing Signed Payments and Payer Account keys would be at risk. ` +
      `Re-run with --force to deploy anyway, or use a fresh Allowance account.`,
  };
}

const NOT_INITIALIZED = /The contract is not initialized/;

/** True only for near-sdk's panic on a contract whose `#[init]` has not run. */
export function isNotInitializedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const panic = (error as { panicMessage?: unknown }).panicMessage;
  return NOT_INITIALIZED.test(error.message) || (typeof panic === "string" && NOT_INITIALIZED.test(panic));
}

/**
 * Why `permission` (an RPC access-key permission view) is wrong for the
 * Agent's key, or null if it is a function-call key for exactly
 * `tracer_sign` on the Allowance.
 */
export function agentKeyProblem(permission: unknown, allowanceId: string): string | null {
  if (permission === "FullAccess") {
    return "is a full-access key; the Agent may only hold a function-call key";
  }
  const call =
    typeof permission === "object" && permission !== null && "FunctionCall" in permission
      ? (permission as { FunctionCall: { receiver_id?: unknown; method_names?: unknown } }).FunctionCall
      : undefined;
  if (!call) {
    return `is not a function-call key (${JSON.stringify(permission)})`;
  }
  if (call.receiver_id !== allowanceId) {
    return `may call ${String(call.receiver_id)}, not the Allowance ${allowanceId}`;
  }
  const methods = Array.isArray(call.method_names) ? call.method_names : [];
  if (methods.length !== 1 || methods[0] !== AGENT_METHOD) {
    return `may call methods ${JSON.stringify(methods)} (empty means any), not exactly ["${AGENT_METHOD}"]`;
  }
  return null;
}

export type PayerAccountState = "ready" | "missing" | "keys-not-recorded" | "keys-without-account";

export function payerAccountState({ keys, exists }: { keys: string[]; exists: boolean }): PayerAccountState {
  if (keys.length > 0) return exists ? "ready" : "keys-without-account";
  return exists ? "keys-not-recorded" : "missing";
}

async function main(argv: readonly string[]): Promise<void> {
  const { force } = parseDeployArgs(argv);
  loadEnv();
  ensureCredentialsDir();
  const ownerId = requireEnv("OWNER_ACCOUNT_ID");
  const owner = await accountFromCredentials(ownerId);
  // ALLOWANCE_PREFIX lets a fresh Allowance be deployed when the state layout changes (it is never migrated).
  const allowanceId = `${process.env.ALLOWANCE_PREFIX ?? "allowance"}.${ownerId}`;

  const allowance = await ensureAllowanceAccount(owner, allowanceId);
  await ensureCode(allowance, force);
  await ensureInitialized(allowance, ownerId);
  const agentKeyFile = await ensureAgentKey(allowance);

  step("register the Allowance for USDC storage");
  console.log((await registerUsdc(owner, allowanceId)) ? "  registered" : "  skip: already registered");

  await ensurePayerAccount(owner, allowanceId);

  step("write .env");
  setEnvValue("ALLOWANCE_ACCOUNT_ID", allowanceId);
  setEnvValue("AGENT_KEY_FILE", agentKeyFile);
  console.log(`  ALLOWANCE_ACCOUNT_ID=${allowanceId}\n  AGENT_KEY_FILE=${agentKeyFile}`);

  console.log(`\nDone. ${accountLink(allowanceId)}`);
  console.log(`Fund it with: pnpm --filter tracer fund <USDC amount>`);
}

function step(title: string): void {
  console.log(`\n== ${title}`);
}

async function ensureAllowanceAccount(owner: Account, allowanceId: string): Promise<Account> {
  step(`create ${allowanceId}`);
  const keyFile = accountKeyFile(allowanceId);
  if (await accountExists(allowanceId)) {
    if (!existsSync(keyFile)) {
      throw new Error(`${allowanceId} exists but ${keyFile} is missing; cannot deploy to it`);
    }
    console.log("  skip: account exists");
    return accountWithKey(allowanceId, readKeyFile(keyFile));
  }
  // Reuse a key from an earlier, interrupted run; otherwise save the new key before using it.
  let secretKey: KeyPairString;
  if (existsSync(keyFile)) {
    secretKey = readKeyFile(keyFile);
  } else {
    const keyPair = KeyPair.fromRandom("ed25519");
    secretKey = keyPair.toString() as KeyPairString;
    writeKeyFile(keyFile, {
      account_id: allowanceId,
      public_key: keyPair.getPublicKey().toString(),
      private_key: secretKey,
    });
  }
  const outcome = await owner.createSubAccount({
    accountOrPrefix: allowanceId,
    publicKey: KeyPair.fromString(secretKey).getPublicKey(),
    nearToTransfer: ALLOWANCE_BALANCE,
  });
  console.log(`  created, key in ${keyFile}\n  ${txLink(outcome.transaction_outcome.id)}`);
  return accountWithKey(allowanceId, secretKey);
}

/** Always builds: cargo is incremental, and a stale wasm would silently deploy old code. */
function buildWasm(): Uint8Array {
  console.log("  cargo near build non-reproducible-wasm");
  execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: CONTRACT_DIR, stdio: "inherit" });
  return readFileSync(WASM);
}

async function ensureCode(allowance: Account, force: boolean): Promise<void> {
  step("build and deploy the contract");
  const wasm = buildWasm();
  const built = baseEncode(createHash("sha256").update(wasm).digest());
  const { code_hash: deployed } = await (await provider()).viewAccount({ accountId: allowance.accountId });
  const decision = deployDecision({
    accountId: allowance.accountId,
    deployed,
    built,
    hasState: deployed === built ? true : await hasContractState(allowance.accountId),
    force,
  });
  if (decision.action === "skip") {
    console.log(`  skip: ${built} already deployed`);
    return;
  }
  if (decision.action === "refuse") {
    throw new Error(`refusing to redeploy: ${decision.reason}`);
  }
  if (force && deployed !== EMPTY_CODE_HASH) {
    console.warn(`  --force: replacing ${deployed} with ${built} over existing contract state`);
  }
  const outcome = await allowance.deployContract(wasm);
  console.log(`  deployed ${built}\n  ${txLink(outcome.transaction_outcome.id)}`);
}

async function ensureInitialized(allowance: Account, ownerId: string): Promise<void> {
  step("initialize");
  if (await hasContractState(allowance.accountId)) {
    try {
      console.log(`  skip: initialized, Payer Account ${await payerAccountId(allowance.accountId)}`);
      return;
    } catch (error) {
      if (!isNotInitializedError(error)) throw error;
    }
  }
  const outcome = await allowance.callFunctionRaw({
    contractId: allowance.accountId,
    methodName: "new",
    args: {
      owner_id: ownerId,
      asset_id: USDC_TESTNET,
      signer_id: MPC_SIGNER_ID,
      domain_id: MPC_ED25519_DOMAIN_ID,
    },
    gas: 30n * TGAS,
  });
  console.log(`  new(): ${txLink(outcome.transaction_outcome.id)}`);
}

async function ensureAgentKey(allowance: Account): Promise<string> {
  step("add the Agent's function-call key");
  const keyFile = join(CREDENTIALS_DIR, `agent-${allowance.accountId}.json`);
  if (!existsSync(keyFile)) {
    const keyPair = KeyPair.fromRandom("ed25519");
    writeKeyFile(keyFile, {
      account_id: allowance.accountId,
      public_key: keyPair.getPublicKey().toString(),
      private_key: keyPair.toString(),
    });
    console.log(`  new Agent key saved to ${keyFile}`);
  }
  const publicKey = KeyPair.fromString(readKeyFile(keyFile)).getPublicKey().toString();
  const existing = (await allowance.getAccessKeyList()).keys.find(k => k.public_key === publicKey);
  if (existing) {
    const problem = agentKeyProblem(existing.access_key.permission, allowance.accountId);
    if (problem) {
      throw new Error(
        `the Agent key ${publicKey} on ${allowance.accountId} ${problem}. ` +
          `Delete that key from the account (it is not safe to hand to an Agent), then re-run deploy to add a correct one.`,
      );
    }
    console.log(`  skip: ${publicKey} already on the account, ${AGENT_METHOD} only`);
    return keyFile;
  }
  const outcome = await allowance.addFunctionCallAccessKey({
    publicKey,
    contractId: allowance.accountId,
    methodNames: [AGENT_METHOD],
    allowance: AGENT_GAS_ALLOWANCE,
  });
  console.log(`  added ${publicKey}\n  ${txLink(outcome.transaction_outcome.id)}`);
  return keyFile;
}

async function ensurePayerAccount(owner: Account, allowanceId: string): Promise<void> {
  const payerId = await payerAccountId(allowanceId);
  step(`create the Payer Account ${payerId}`);
  let state = payerAccountState({ keys: await payerKeys(allowanceId), exists: await accountExists(payerId) });
  if (state === "missing") {
    try {
      const outcome = await owner.callFunctionRaw({
        contractId: allowanceId,
        methodName: "create_payer_account",
        args: { key_count: PAYER_KEY_COUNT },
        deposit: CREATE_PAYER_DEPOSIT,
        gas: 300n * TGAS,
      });
      console.log(`  ${txLink(outcome.transaction_outcome.id)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/payer account creation already in progress/.test(message)) {
        throw new Error(
          `create_payer_account is already in progress on ${allowanceId} (an earlier call has not finished). ` +
            `Wait a minute for its callbacks to land, then re-run deploy.`,
        );
      }
      if (!/payer account already created/.test(message)) throw error;
      console.log("  an earlier call already created it");
    }
    state = payerAccountState({ keys: await payerKeys(allowanceId), exists: await accountExists(payerId) });
    if (state === "missing") {
      throw new Error(
        `create_payer_account finished but ${payerId} was not created and no keys were recorded; ` +
          `see the transaction's logs (derived_public_key or create_account failed), then re-run deploy.`,
      );
    }
  } else if (state === "ready") {
    console.log("  skip: Payer Account exists and its keys are recorded");
  }
  if (state === "keys-not-recorded") {
    throw new Error(
      `${payerId} exists but payer_keys() is empty. Either create_payer_account is still in flight ` +
        `(on_payer_created has not run yet: wait a minute and re-run deploy), or the account was created ` +
        `by an earlier contract version whose keys this state does not hold. In that case the Allowance ` +
        `cannot sign for it; set up a fresh Allowance account. ${accountLink(payerId)}`,
    );
  }
  if (state === "keys-without-account") {
    throw new Error(
      `payer_keys() lists keys but ${payerId} does not exist; the contract state is inconsistent. ` +
        `Set up a fresh Allowance account. ${accountLink(allowanceId)}`,
    );
  }

  const keys = await payerKeys(allowanceId);
  const onChain = (await (await provider()).viewAccessKeyList({ accountId: payerId })).keys;
  console.log(`  payer_keys(): ${keys.join(", ")}`);
  for (const key of onChain) {
    console.log(`  on chain: ${key.public_key} ${JSON.stringify(key.access_key.permission)}`);
  }
  const missing = keys.filter(k => !onChain.some(o => o.public_key === k));
  if (missing.length > 0) {
    throw new Error(`payer_keys() not on ${payerId}: ${missing.join(", ")}`);
  }

  if (await isUsdcRegistered(payerId)) {
    console.log("  USDC storage: registered");
  } else {
    console.log("  USDC storage: missing (the contract's storage_deposit did not land); registering");
    await registerUsdc(owner, payerId);
    if (!(await isUsdcRegistered(payerId))) throw new Error(`${payerId} is still not registered for USDC storage`);
    console.log("  USDC storage: registered");
  }
  console.log(`  ${accountLink(payerId)}`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
