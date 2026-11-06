/**
 * Seam 2 for ticket #11: the deploy script's real flow against the sandbox (mock signer,
 * mock USDC), as a fresh Owner with no Allowance yet. The lock must hold afterwards and
 * the Agent's saved key must be able to spend, and nothing else.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account } from "near-api-js";
import { chainFor, deployAllowance, parseConfig, planDeploy, readKeyFile, type RawConfig } from "deploy";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SPEND_GAS, newRequestId, type SpendRequest } from "../src/agent.js";
import { readContracts } from "../src/contracts.js";
import { NEAR, TGAS, USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;
let owner: Account;
let newPayee: Account;
let credentialsDir: string;

beforeAll(async () => {
  h = await startHarness({ allowanceUsdc: 0n });
  owner = await h.createFundedAccount("deployer", 40n, 20n * USDC);
  // Not registered with USDC: the deploy must register it.
  newPayee = await h.createAccount("seller", 5n);
  credentialsDir = mkdtempSync(join(tmpdir(), "allowance-deploy-"));
});

afterAll(async () => {
  await h?.stop();
  if (credentialsDir) rmSync(credentialsDir, { recursive: true, force: true });
});

function config(name: string, fundNear = "10"): RawConfig {
  return {
    network: "sandbox",
    rpcUrls: [h.rpcUrl],
    signerId: h.signer.accountId,
    usdcContractId: h.usdc.accountId,
    owner: owner.accountId,
    name,
    policy: { dailyCap: "10", autoLimit: "2", hardCeiling: "5", velocityLimit: 4, maxTimeoutBlocks: 120 },
    payees: [h.payee.accountId, newPayee.accountId],
    keyCount: 4,
    fund: { usdc: "7", near: fundNear },
    // Sandbox gas costs ~10x testnet's.
    agentGasNear: "20",
  };
}

function input(name: string, fundNear?: string) {
  const { settings } = parseConfig(config(name, fundNear));
  return {
    settings,
    chain: chainFor(h.rpcUrl, h.provider),
    owner,
    wasm: readContracts().allowance,
    credentialsDir,
    log: () => {},
  };
}

test("deploys a locked Allowance that the saved Agent key can spend from", async () => {
  const deploy = input("allow1");
  const allowanceId = deploy.settings.allowanceId;
  await h.registerDerivedKeys(allowanceId, 4);

  const result = await deployAllowance(deploy);
  expect(result.lock.problems).toEqual([]);
  expect(result.lock.locked).toBe(true);

  // The lock, read straight from the chain.
  const allowanceKeys = (await h.provider.viewAccessKeyList({ accountId: allowanceId })).keys;
  expect(allowanceKeys.filter((k) => k.access_key.permission === "FullAccess")).toEqual([]);
  expect(allowanceKeys).toHaveLength(1);
  expect(allowanceKeys[0]!.public_key).toBe(result.agentPublicKey);
  expect(allowanceKeys[0]!.access_key.permission).toMatchObject({
    FunctionCall: { receiver_id: allowanceId, method_names: ["request_spend"] },
  });
  const payerKeysView = await h.view<string[]>(allowanceId, "payer_keys");
  const payerKeys = (await h.provider.viewAccessKeyList({ accountId: result.payerAccountId })).keys;
  expect(payerKeys.map((k) => k.public_key).sort()).toEqual([...payerKeysView].sort());
  expect(payerKeysView).toHaveLength(4);

  // Payees registered and allowed; USDC credited.
  expect((await h.view<string[]>(allowanceId, "get_allowlist")).sort()).toEqual([h.payee.accountId, newPayee.accountId].sort());
  expect(await h.view(h.usdc.accountId, "storage_balance_of", { account_id: newPayee.accountId })).not.toBeNull();
  expect(await h.view(h.usdc.accountId, "storage_balance_of", { account_id: result.payerAccountId })).not.toBeNull();
  expect(await h.usdcBalance(allowanceId)).toBe(7n * USDC);
  expect(await h.view(allowanceId, "get_policy")).toEqual(deploy.settings.policy);

  // The Agent, with the key the deploy saved: request_spend works and is Signed...
  const agent = new Account(allowanceId, h.provider, readKeyFile(result.agentKeyFile));
  const requestId = newRequestId();
  const submitted = await h.callNow<SpendRequest>(
    agent,
    allowanceId,
    "request_spend",
    { request_id: requestId, payee: newPayee.accountId, amount: USDC.toString(), memo: null, max_timeout_blocks: 60 },
    SPEND_GAS,
  );
  expect(submitted.outcome).toBe("Approved");
  let request: SpendRequest | null = null;
  for (let i = 0; i < 120; i++) {
    request = await h.view<SpendRequest | null>(allowanceId, "get_request", { request_id: requestId });
    if (request && request.status !== "Funding" && request.status !== "Signing") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  h.assertResponderHealthy();
  expect(request?.status).toBe("Signed");
  expect(request?.payment?.signed_delegate_action).toBeTruthy();

  // ...and it can call nothing else.
  await expect(
    agent.callFunction({ contractId: allowanceId, methodName: "add_payee", args: { payee: "evil.test.near" }, deposit: 1n, gas: 30n * TGAS }),
  ).rejects.toThrow();
  await expect(agent.transfer({ receiverId: owner.accountId, amount: NEAR })).rejects.toThrow();
});

test("refuses to touch an Allowance that already exists", async () => {
  const plan = await planDeploy(input("allow1"));
  expect(plan.refusals.join("\n")).toMatch(/allow1\..* already exists/);
  expect(plan.refusals.join("\n")).toMatch(/refusing to overwrite an Agent key/);
  await expect(deployAllowance(input("allow1"))).rejects.toThrow(/refusing to deploy/);
});

test("the plan refuses too little NEAR and a signer that can't derive keys, without sending anything", async () => {
  const deploy = input("allow2", "1");
  const plan = await planDeploy(deploy);
  const refusals = plan.refusals.join("\n");
  expect(refusals).toMatch(/fund.near 1 is below/);
  // No derived keys registered for allow2 with the mock signer.
  expect(refusals).toMatch(/cannot derive keys/);
  expect(await deploy.chain.accountExists(deploy.settings.allowanceId)).toBe(false);
});
