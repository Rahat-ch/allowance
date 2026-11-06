/**
 * The deploy itself, against any network: the CLI (main.ts) points it at testnet, the
 * sandbox test at near-sandbox with the mock signer and mock USDC.
 *
 *   1. one transaction from the Owner creates `<name>.<owner>`, funds it with NEAR,
 *      deploys the contract and calls `new`, which adds the Agent's function-call key
 *      (request_spend only). The account is never given a full-access key, so there is
 *      no deployer key to delete and no moment at which anyone holds one (ADR 0004);
 *      if `new` fails, the whole transaction reverts and nothing is left behind
 *   2. `create_payer_account(key_count)`: the contract creates `pay.<allowance>` with
 *      only keys derived from it by the signer, and registers its USDC storage
 *   3. USDC storage for the Allowance and every Payee (`storage_deposit` if missing)
 *   4. `add_payee` for every Payee (1 yoctoNEAR)
 *   5. USDC via `ft_transfer_call`, then checks the Allowance credited it
 *   6. verifies the lock from chain state (lock.ts) and throws if it does not hold
 *
 * `planDeploy` runs every check that needs no transaction, and refuses to touch an
 * Allowance account that already exists: every deploy is a fresh Allowance.
 */
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, actions, baseEncode, type Account } from "near-api-js";
import type { Chain } from "./chain.js";
import { STORAGE_PRICE_PER_BYTE } from "./chain.js";
import type { DeploySettings } from "./config.js";
import { writeKeyFile } from "./keys.js";
import { verifyLock, type LockReport } from "./lock.js";
import { NEAR, TGAS, formatNear, formatUsdc } from "./units.js";

/** What the contract sends the Payer Account on creation (PAYER_ACCOUNT_BALANCE + its USDC storage). */
const PAYER_ACCOUNT_COST = 101_250_000_000_000_000_000_000n;
/** NEAR the Allowance should keep beyond code storage and the Payer Account, for state and signing. */
export const ALLOWANCE_NEAR_MARGIN = NEAR / 2n;
/** Gas the Owner's transactions may burn, all together (generous: sandbox gas costs ~10x testnet). */
const OWNER_GAS_MARGIN = NEAR / 2n;
/** Initial contract state, roughly; the margin covers its growth. */
const INITIAL_STATE_BYTES = 2_000n;

export type DeployInput = {
  settings: DeploySettings;
  chain: Chain;
  /** Signs as the Owner. */
  owner: Account;
  /** The Allowance contract to deploy. */
  wasm: Uint8Array;
  /** Where the Agent's key file is written (`~/.near-credentials/<network>` for real networks). */
  credentialsDir: string;
  log?: (line: string) => void;
};

export type Plan = {
  settings: DeploySettings;
  codeHash: string;
  wasmBytes: number;
  /** Least NEAR the Allowance should be created with. */
  minAllowanceNear: bigint;
  /** NEAR the Owner spends, gas margin included. */
  ownerNearNeeded: bigint;
  ownerNearAvailable: bigint;
  ownerUsdc: bigint;
  /** Accounts that need USDC storage registered (the Allowance and unregistered Payees). */
  toRegister: string[];
  storageDeposit: bigint;
  agentKeyFile: string;
  /** Reasons not to deploy; empty when the deploy may go ahead. */
  refusals: string[];
  warnings: string[];
};

export type DeployResult = {
  allowanceId: string;
  payerAccountId: string;
  agentKeyFile: string;
  agentPublicKey: string;
  transactions: { label: string; hash: string }[];
  lock: LockReport;
  usdcBalance: bigint;
};

export function agentKeyFileFor(credentialsDir: string, allowanceId: string): string {
  return join(credentialsDir, `agent-${allowanceId}.json`);
}

/** NEAR's code_hash: base58 sha256 of the wasm. */
export function codeHashOf(wasm: Uint8Array): string {
  return baseEncode(createHash("sha256").update(wasm).digest());
}

/** Least NEAR the Allowance account needs: code and state storage, the Payer Account, and a margin. */
export function minAllowanceNear(wasmBytes: number): bigint {
  return (BigInt(wasmBytes) + INITIAL_STATE_BYTES) * STORAGE_PRICE_PER_BYTE + PAYER_ACCOUNT_COST + ALLOWANCE_NEAR_MARGIN;
}

type StorageBalanceBounds = { min: string; max: string | null };

async function isRegistered(chain: Chain, usdc: string, accountId: string): Promise<boolean> {
  return (await chain.view<object | null>(usdc, "storage_balance_of", { account_id: accountId })) !== null;
}

/** Every check that needs no transaction. Never changes chain state. */
export async function planDeploy(input: DeployInput, extraWarnings: string[] = []): Promise<Plan> {
  const { settings: s, chain, wasm, credentialsDir } = input;
  const usdc = s.network.usdcContractId;
  const refusals: string[] = [];
  const warnings = [...extraWarnings];

  if (await chain.accountExists(s.allowanceId)) {
    refusals.push(`${s.allowanceId} already exists; refusing to touch it. Pick a new name (config "name", ALLOWANCE_NAME or --name)`);
  }
  if (await chain.accountExists(s.payerAccountId)) {
    refusals.push(`${s.payerAccountId} already exists; pick a new name`);
  }
  const agentKeyFile = agentKeyFileFor(credentialsDir, s.allowanceId);
  if (existsSync(agentKeyFile)) {
    refusals.push(`${agentKeyFile} already exists (from an earlier deploy?); refusing to overwrite an Agent key`);
  }

  const minNear = minAllowanceNear(wasm.length);
  if (s.fundNear < minNear) {
    refusals.push(
      `fund.near ${formatNear(s.fundNear)} is below the ${formatNear(minNear)} NEAR the Allowance needs ` +
        `(${wasm.length} bytes of code storage, the Payer Account, and a ${formatNear(ALLOWANCE_NEAR_MARGIN)} NEAR margin)`,
    );
  }

  const bounds = await chain.view<StorageBalanceBounds>(usdc, "storage_balance_bounds");
  const storageDeposit = BigInt(bounds.min);
  const toRegister: string[] = [];
  for (const id of [s.allowanceId, ...s.payees]) {
    if (!(await isRegistered(chain, usdc, id))) toRegister.push(id);
  }
  for (const payee of s.payees) {
    if (!(await chain.accountExists(payee))) warnings.push(`payee ${payee} does not exist yet (its USDC storage is registered anyway)`);
  }

  let ownerNearAvailable = 0n;
  let ownerUsdc = 0n;
  const ownerNearNeeded = s.fundNear + storageDeposit * BigInt(toRegister.length) + OWNER_GAS_MARGIN;
  if (!(await chain.accountExists(s.ownerId))) {
    refusals.push(`the Owner ${s.ownerId} does not exist on ${s.network.name}`);
  } else {
    const balance = await chain.balance(s.ownerId);
    ownerNearAvailable = balance.total - balance.storageLocked;
    if (ownerNearAvailable < ownerNearNeeded) {
      refusals.push(
        `the Owner has ${formatNear(ownerNearAvailable)} NEAR available but needs about ${formatNear(ownerNearNeeded)} ` +
          `(fund.near, USDC storage deposits and a ${formatNear(OWNER_GAS_MARGIN)} NEAR gas margin)`,
      );
    }
    ownerUsdc = BigInt(await chain.view<string>(usdc, "ft_balance_of", { account_id: s.ownerId }));
    if (ownerUsdc < s.fundUsdc) {
      refusals.push(`the Owner has ${formatUsdc(ownerUsdc)} USDC (${usdc}) but fund.usdc is ${formatUsdc(s.fundUsdc)}`);
    }
  }

  // The signer must derive keys for the new Allowance, or create_payer_account fails.
  try {
    await chain.view<string>(s.network.signerId, "derived_public_key", {
      path: "x402/0",
      predecessor: s.allowanceId,
      domain_id: s.network.domainId,
    });
  } catch (error) {
    refusals.push(`the signer ${s.network.signerId} cannot derive keys for ${s.allowanceId}: ${(error as Error).message}`);
  }

  return {
    settings: s,
    codeHash: codeHashOf(wasm),
    wasmBytes: wasm.length,
    minAllowanceNear: minNear,
    ownerNearNeeded,
    ownerNearAvailable,
    ownerUsdc,
    toRegister,
    storageDeposit,
    agentKeyFile,
    refusals,
    warnings,
  };
}

/** The plan as lines to print. */
export function describePlan(plan: Plan): string[] {
  const s = plan.settings;
  const p = s.policy;
  return [
    `network      ${s.network.name} (RPC ${s.network.rpcUrls[0]}, signer ${s.network.signerId} domain ${s.network.domainId})`,
    `USDC         ${s.network.usdcContractId}`,
    `Owner        ${s.ownerId} (${formatNear(plan.ownerNearAvailable)} NEAR available, ${formatUsdc(plan.ownerUsdc)} USDC)`,
    `Allowance    ${s.allowanceId}, created with ${formatNear(s.fundNear)} NEAR (needs >= ${formatNear(plan.minAllowanceNear)})`,
    `contract     ${plan.wasmBytes} bytes, code hash ${plan.codeHash}`,
    `Policy       Daily Cap ${formatUsdc(BigInt(p.daily_cap))}, Auto Limit ${formatUsdc(BigInt(p.auto_limit))}, ` +
      `Hard Ceiling ${formatUsdc(BigInt(p.hard_ceiling))} USDC; Velocity Limit ${p.velocity_limit}/hour; ` +
      `max timeout ${p.max_timeout_blocks} blocks`,
    `Payer        ${s.payerAccountId} with ${s.keyCount} derived keys ` +
      `(needs >= ${s.pool.requiredKeys}: ~${s.pool.concurrentAtVelocity.toFixed(2)} payments outstanding at the Velocity Limit)`,
    `Payees       ${s.payees.length ? s.payees.join(", ") : "(none)"}`,
    `USDC storage ${plan.toRegister.join(", ")} (${formatNear(plan.storageDeposit)} NEAR each)`,
    `funding      ${formatUsdc(s.fundUsdc)} USDC via ft_transfer_call`,
    `Agent key    ${formatNear(s.agentAllowance)} NEAR gas allowance, saved to ${plan.agentKeyFile}`,
    `Owner spends about ${formatNear(plan.ownerNearNeeded)} NEAR (gas margin included)`,
  ];
}

export function explorerAccount(settings: DeploySettings, accountId: string): string {
  return settings.network.explorerUrl ? `${settings.network.explorerUrl}/address/${accountId}` : accountId;
}

export function explorerTx(settings: DeploySettings, hash: string): string {
  return settings.network.explorerUrl ? `${settings.network.explorerUrl}/txns/${hash}` : hash;
}

/** Plans, refuses if the plan does, then deploys, funds and verifies the lock. */
export async function deployAllowance(input: DeployInput, plan?: Plan): Promise<DeployResult> {
  const { settings: s, chain, owner, wasm } = input;
  const log = input.log ?? console.log;
  plan ??= await planDeploy(input);
  if (plan.refusals.length > 0) {
    throw new Error(`refusing to deploy:\n${plan.refusals.map((r) => `  - ${r}`).join("\n")}`);
  }
  if (owner.accountId !== s.ownerId) throw new Error(`owner account ${owner.accountId} is not the configured Owner ${s.ownerId}`);
  const usdc = s.network.usdcContractId;
  const transactions: DeployResult["transactions"] = [];
  const step = (title: string) => log(`\n== ${title}`);
  const record = (label: string, tx: { transaction_outcome: { id: string } }) => {
    const hash = tx.transaction_outcome.id;
    transactions.push({ label, hash });
    log(`  ${label}: ${explorerTx(s, hash)}`);
  };

  // ---- 1. create, deploy, initialize ----
  step(`create ${s.allowanceId}, deploy and initialize`);
  const agentKey = KeyPair.fromRandom("ed25519");
  const agentPublicKey = agentKey.getPublicKey().toString();
  writeKeyFile(plan.agentKeyFile, { account_id: s.allowanceId, public_key: agentPublicKey, private_key: agentKey.toString() });
  log(`  Agent key ${agentPublicKey} saved to ${plan.agentKeyFile}`);
  try {
    const tx = await owner.signAndSendTransaction({
      receiverId: s.allowanceId,
      actions: [
        actions.createAccount(),
        actions.transfer(s.fundNear),
        actions.deployContract(wasm),
        actions.functionCall(
          "new",
          {
            owner_id: s.ownerId,
            agent_public_key: agentPublicKey,
            asset_id: usdc,
            signer_id: s.network.signerId,
            domain_id: s.network.domainId,
            policy: s.policy,
            agent_allowance: s.agentAllowance.toString(),
          },
          50n * TGAS,
          0n,
        ),
      ],
      throwOnFailure: true,
    });
    record("create + deploy + new", tx);
  } catch (error) {
    // A failed transaction reverts entirely; drop the unused Agent key so the name can be retried.
    if (!(await chain.accountExists(s.allowanceId))) rmSync(plan.agentKeyFile, { force: true });
    throw error;
  }

  try {
    // ---- 2. Payer Account ----
    step(`create the Payer Account ${s.payerAccountId} (${s.keyCount} derived keys)`);
    record(
      "create_payer_account",
      await owner.callFunctionRaw({
        contractId: s.allowanceId,
        methodName: "create_payer_account",
        args: { key_count: s.keyCount },
        gas: 300n * TGAS,
      }),
    );
    const payerKeysView = await chain.view<string[]>(s.allowanceId, "payer_keys");
    if (payerKeysView.length !== s.keyCount || !(await chain.accountExists(s.payerAccountId))) {
      throw new Error(
        `create_payer_account did not create ${s.payerAccountId} with ${s.keyCount} keys ` +
          `(payer_keys() lists ${payerKeysView.length}); see the transaction's logs`,
      );
    }
    if (!(await isRegistered(chain, usdc, s.payerAccountId))) {
      log("  the contract's USDC storage_deposit for the Payer Account did not land; registering it");
      plan.toRegister.push(s.payerAccountId);
    }

    // ---- 3. USDC storage ----
    step("register USDC storage");
    for (const id of plan.toRegister) {
      if (await isRegistered(chain, usdc, id)) {
        log(`  ${id}: already registered`);
        continue;
      }
      record(
        `storage_deposit ${id}`,
        await owner.callFunctionRaw({
          contractId: usdc,
          methodName: "storage_deposit",
          args: { account_id: id, registration_only: true },
          deposit: plan.storageDeposit,
          gas: 30n * TGAS,
        }),
      );
    }
    for (const id of [s.allowanceId, s.payerAccountId, ...s.payees]) {
      if (!(await isRegistered(chain, usdc, id))) throw new Error(`${id} is still not registered for USDC storage`);
    }

    // ---- 4. Payees ----
    step("add Payees");
    for (const payee of s.payees) {
      record(
        `add_payee ${payee}`,
        await owner.callFunctionRaw({
          contractId: s.allowanceId,
          methodName: "add_payee",
          args: { payee },
          deposit: 1n,
          gas: 30n * TGAS,
        }),
      );
    }
    const allowlist = await chain.view<string[]>(s.allowanceId, "get_allowlist");
    const notListed = s.payees.filter((p) => !allowlist.includes(p));
    if (notListed.length > 0) throw new Error(`not on the Allowlist after add_payee: ${notListed.join(", ")}`);

    // ---- 5. USDC ----
    step(`fund ${formatUsdc(s.fundUsdc)} USDC`);
    if (s.fundUsdc > 0n) {
      record(
        "ft_transfer_call",
        await owner.callFunctionRaw({
          contractId: usdc,
          methodName: "ft_transfer_call",
          args: { receiver_id: s.allowanceId, amount: s.fundUsdc.toString(), msg: "" },
          deposit: 1n,
          gas: 100n * TGAS,
        }),
      );
    }
    const budget = await chain.view<{ usdc_balance: string; near_balance: string }>(s.allowanceId, "get_budget");
    const usdcBalance = BigInt(budget.usdc_balance);
    if (usdcBalance !== s.fundUsdc) {
      throw new Error(`the Allowance credited ${formatUsdc(usdcBalance)} USDC, expected ${formatUsdc(s.fundUsdc)}`);
    }
    log(`  Allowance balance: ${formatUsdc(usdcBalance)} USDC, ${formatNear(BigInt(budget.near_balance))} NEAR`);

    // ---- 6. the lock ----
    step("verify the lock");
    const lock = await checkLock(chain, s, plan.codeHash);
    for (const line of lock.checks) log(`  ok: ${line}`);
    for (const line of lock.problems) log(`  NOT LOCKED: ${line}`);
    if (!lock.locked) throw new Error(`the Allowance is not locked:\n${lock.problems.map((p) => `  - ${p}`).join("\n")}`);

    return {
      allowanceId: s.allowanceId,
      payerAccountId: s.payerAccountId,
      agentKeyFile: plan.agentKeyFile,
      agentPublicKey,
      transactions,
      lock,
      usdcBalance,
    };
  } catch (error) {
    log(
      `\n${s.allowanceId} was created but setup stopped. It never had a full-access key, so it can't be ` +
        `redeployed; finish with Owner calls or deploy a fresh Allowance with a new name.`,
    );
    throw error;
  }
}

/** Reads the chain and checks the lock (lock.ts) for a deployed Allowance. */
export async function checkLock(chain: Chain, s: DeploySettings, builtCodeHash?: string): Promise<LockReport> {
  const payerKeysView = await chain.view<string[]>(s.allowanceId, "payer_keys");
  const derivedKeys = await Promise.all(
    payerKeysView.map((_, i) =>
      chain.view<string>(s.network.signerId, "derived_public_key", {
        path: `x402/${i}`,
        predecessor: s.allowanceId,
        domain_id: s.network.domainId,
      }),
    ),
  );
  const { codeHash } = await chain.balance(s.allowanceId);
  return verifyLock({
    allowanceId: s.allowanceId,
    allowanceKeys: await chain.accessKeys(s.allowanceId),
    agentKey: await chain.view<string>(s.allowanceId, "get_agent_key"),
    payerAccountId: s.payerAccountId,
    payerKeys: await chain.accessKeys(s.payerAccountId),
    payerKeysView,
    derivedKeys,
    expectedKeyCount: s.keyCount,
    ...(builtCodeHash ? { codeHash: { deployed: codeHash, built: builtCodeHash } } : {}),
  });
}

/** The closing summary: ids, key file and explorer links. */
export function describeResult(s: DeploySettings, r: DeployResult): string[] {
  return [
    `Allowance       ${r.allowanceId}  ${explorerAccount(s, r.allowanceId)}`,
    `Payer Account   ${r.payerAccountId}  ${explorerAccount(s, r.payerAccountId)}`,
    `Owner           ${s.ownerId}  ${explorerAccount(s, s.ownerId)}`,
    `Agent key       ${r.agentPublicKey} (request_spend only) in ${r.agentKeyFile}`,
    `USDC balance    ${formatUsdc(r.usdcBalance)}`,
    `transactions:`,
    ...r.transactions.map((t) => `  ${t.label}: ${explorerTx(s, t.hash)}`),
  ];
}
