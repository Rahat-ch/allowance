/**
 * `pnpm --filter tracer deploy`: sets up an Allowance on testnet for the tracer.
 *
 *   1. creates `allowance.<OWNER_ACCOUNT_ID>` with 5 NEAR
 *   2. deploys target/near/allowance/allowance.wasm (building it if missing)
 *   3. calls `new` (signer v1.signer-prod.testnet, Ed25519 domain 1)
 *   4. adds the Agent's function-call key (tracer_sign only, 1 NEAR gas allowance)
 *   5. registers the Allowance for USDC storage
 *   6. calls `create_payer_account({key_count: 4})` as the Owner
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
  loadEnv,
  readKeyFile,
  requireEnv,
  setEnvValue,
  txLink,
  writeKeyFile,
  type KeyPairString,
} from "./config.js";
import { NEAR, TGAS, accountExists, accountFromCredentials, accountWithKey, provider, registerUsdc } from "./near.js";

const WASM = join(REPO_ROOT, "target", "near", "allowance", "allowance.wasm");
const CONTRACT_DIR = join(REPO_ROOT, "contracts", "allowance");
const ALLOWANCE_BALANCE = 5n * NEAR;
const AGENT_GAS_ALLOWANCE = 1n * NEAR;
const PAYER_KEY_COUNT = 4;
const CREATE_PAYER_DEPOSIT = 1n * NEAR;

async function main(): Promise<void> {
  loadEnv();
  const ownerId = requireEnv("OWNER_ACCOUNT_ID");
  const owner = accountFromCredentials(ownerId);
  const allowanceId = `allowance.${ownerId}`;

  const allowance = await ensureAllowanceAccount(owner, allowanceId);
  await ensureCode(allowance);
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

function ensureWasm(): Uint8Array {
  if (!existsSync(WASM)) {
    console.log(`  ${WASM} missing; building`);
    execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: CONTRACT_DIR, stdio: "inherit" });
  }
  return readFileSync(WASM);
}

async function ensureCode(allowance: Account): Promise<void> {
  step("deploy the contract");
  const wasm = ensureWasm();
  const codeHash = baseEncode(createHash("sha256").update(wasm).digest());
  const { code_hash: deployed } = await provider.viewAccount({ accountId: allowance.accountId });
  if (deployed === codeHash) {
    console.log(`  skip: ${codeHash} already deployed`);
    return;
  }
  const outcome = await allowance.deployContract(wasm);
  console.log(`  deployed ${codeHash}\n  ${txLink(outcome.transaction_outcome.id)}`);
}

async function ensureInitialized(allowance: Account, ownerId: string): Promise<void> {
  step("initialize");
  try {
    console.log(`  skip: initialized, Payer Account ${await payerAccountId(allowance.accountId)}`);
    return;
  } catch (error) {
    if (!String(error).match(/not initialized|state.*empty|NotInitialized/i)) {
      console.log(`  payer_account_id view failed (${String(error).slice(0, 120)}); calling new`);
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
    console.log(`  skip: ${publicKey} already on the account`);
    return keyFile;
  }
  const outcome = await allowance.addFunctionCallAccessKey({
    publicKey,
    contractId: allowance.accountId,
    methodNames: ["tracer_sign"],
    allowance: AGENT_GAS_ALLOWANCE,
  });
  console.log(`  added ${publicKey}\n  ${txLink(outcome.transaction_outcome.id)}`);
  return keyFile;
}

async function ensurePayerAccount(owner: Account, allowanceId: string): Promise<void> {
  const payerId = await payerAccountId(allowanceId);
  step(`create the Payer Account ${payerId}`);
  if (await accountExists(payerId)) {
    console.log("  skip: Payer Account exists");
  } else {
    const outcome = await owner.callFunctionRaw({
      contractId: allowanceId,
      methodName: "create_payer_account",
      args: { key_count: PAYER_KEY_COUNT },
      deposit: CREATE_PAYER_DEPOSIT,
      gas: 300n * TGAS,
    });
    console.log(`  ${txLink(outcome.transaction_outcome.id)}`);
    if (!(await accountExists(payerId))) {
      throw new Error(`create_payer_account finished but ${payerId} does not exist`);
    }
  }
  const keys = await payerKeys(allowanceId);
  const onChain = (await provider.viewAccessKeyList({ accountId: payerId })).keys;
  console.log(`  payer_keys(): ${keys.join(", ")}`);
  for (const key of onChain) {
    console.log(`  on chain: ${key.public_key} ${JSON.stringify(key.access_key.permission)}`);
  }
  console.log(`  ${accountLink(payerId)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
