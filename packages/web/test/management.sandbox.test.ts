/**
 * Management (#15) against the real contract on a sandbox: the new views parse, and the
 * calls the page builds (Policy, Allowlist with USDC registration, Withdraw, Agent key) do
 * what they should when the Owner signs them.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { newRequestId, requestSpend } from "sandbox/agent";
import { NEAR, USDC, startHarness, type Harness } from "sandbox/harness";
import { AllowanceViews, addPayeeCalls, explainError, ownerCalls, removalEffects, type OwnerCall } from "../src/allowance.js";

type Account = Harness["owner"];

let h: Harness;
let views: AllowanceViews;

beforeAll(async () => {
  h = await startHarness({ allowanceUsdc: 300n * USDC });
  views = new AllowanceViews(h.rpcUrl, h.allowance.accountId);
});

afterAll(async () => {
  await h?.stop();
});

/** Signs `calls` in order as `account`, the way the page's wallet would. */
async function send(calls: OwnerCall | OwnerCall[], account: Account = h.owner) {
  for (const c of Array.isArray(calls) ? calls : [calls]) {
    await account.callFunction({
      contractId: c.receiverId ?? h.allowance.accountId,
      methodName: c.methodName,
      args: c.args,
      gas: c.gas,
      deposit: c.deposit,
    });
  }
}

async function failure(call: OwnerCall): Promise<string> {
  try {
    await send(call);
  } catch (e) {
    return explainError(e);
  }
  throw new Error(`${call.methodName} unexpectedly succeeded`);
}

const spend = (payee: string, amount: bigint, memo?: string) =>
  requestSpend(h, { request_id: newRequestId(), payee, amount, memo, max_timeout_blocks: 60 });

test("the snapshot names the USDC asset and the Agent key", async () => {
  const s = await views.snapshot();
  expect(s.asset).toBe(h.usdc.accountId);
  expect(s.agentKey).toMatch(/^ed25519:/);
});

test("recent Spend Requests page newest first with Outcome and Blocked reason", async () => {
  const a = await spend(h.payee.accountId, 5n * USDC, "small");
  const b = await spend(h.payee.accountId, 150n * USDC, "big");
  const c = await spend(`nobody.${h.root.accountId}`, USDC);
  expect(c.outcome).toBe("Blocked");

  const all = await views.listRequests(0, 10);
  expect(all.map((r) => r.requestId)).toEqual([c.request_id, b.request_id, a.request_id]);
  expect(all[0]).toMatchObject({ outcome: "Blocked", blockedReason: "UnknownPayee", amount: USDC });
  expect(all[1]).toMatchObject({ outcome: "Pending", status: "Pending", memo: "big", amount: 150n * USDC });
  expect(all[2]).toMatchObject({ outcome: "Approved", blockedReason: null });
  expect((await views.listRequests(1, 1)).map((r) => r.requestId)).toEqual([b.request_id]);
  expect(await views.listRequests(3, 10)).toEqual([]);

  await send(ownerCalls.reject(b.request_id)); // frees Held for the Withdraw test
});

test("adding a Payee registers its USDC storage when it has none", async () => {
  const fresh = await h.createAccount("newpayee", 1n);
  const before = await views.usdcRegistration(h.usdc.accountId, fresh.accountId);
  expect(before).toEqual({ registered: false, deposit: 1_250_000_000_000_000_000_000n });

  const calls = addPayeeCalls(h.usdc.accountId, fresh.accountId, before);
  expect(calls.map((c) => c.methodName)).toEqual(["storage_deposit", "add_payee"]);
  await send(calls);

  expect((await views.usdcRegistration(h.usdc.accountId, fresh.accountId)).registered).toBe(true);
  expect(await views.getAllowlist()).toContain(fresh.accountId);
  // Already registered: only add_payee.
  expect(addPayeeCalls(h.usdc.accountId, h.payee.accountId, await views.usdcRegistration(h.usdc.accountId, h.payee.accountId))).toHaveLength(1);
});

test("removing a Payee rejects exactly the spends the page said it would", async () => {
  const p = (await views.getAllowlist()).find((a) => a.startsWith("newpayee."))!;
  const r = await spend(p, 120n * USDC, "to be rejected");
  expect(r.outcome).toBe("Pending");

  const effects = removalEffects(await views.listPending(), p);
  expect(effects.rejected.map((x) => x.requestId)).toEqual([r.request_id]);
  expect(effects.cancelled).toEqual([]);

  await send(ownerCalls.removePayee(p));
  expect(await views.getAllowlist()).not.toContain(p);
  expect(await views.getRequest(r.request_id)).toMatchObject({ status: "Rejected" });
});

test("the Policy the page saves is the Policy the contract enforces", async () => {
  const policy = { dailyCap: 200n * USDC, autoLimit: 10n * USDC, hardCeiling: 80n * USDC, velocityLimit: 30, maxTimeoutBlocks: 300 };
  await send(ownerCalls.setPolicy(policy));
  expect(await views.getPolicy()).toEqual(policy);
  expect(await failure(ownerCalls.setPolicy({ ...policy, autoLimit: 90n * USDC }))).toMatch(/auto_limit must not exceed hard_ceiling/);
});

test("withdraw is held to Withdrawable and pays the Owner", async () => {
  const { withdrawable } = await views.getBudget();
  expect(withdrawable).toBe(295n * USDC); // 300 deposited, $5 paid out, nothing Held
  expect(await failure(ownerCalls.withdraw(withdrawable + 1n))).toMatch(/more than is Withdrawable/);

  const ownerBefore = await h.usdcBalance(h.owner.accountId);
  await send(ownerCalls.withdraw(withdrawable));
  expect(await h.usdcBalance(h.owner.accountId)).toBe(ownerBefore + withdrawable);
  expect(await views.getBudget()).toMatchObject({ withdrawable: 0n, usdcBalance: 0n });
});

test("replace_agent_key swaps the Agent's key and its gas allowance", async () => {
  const old = await views.getAgentKey();
  const next = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  await send(ownerCalls.replaceAgentKey(next, 2n * NEAR));
  expect(await views.getAgentKey()).toBe(next);

  const keys = (await h.provider.viewAccessKeyList({ accountId: h.allowance.accountId })).keys;
  expect(keys.map((k) => k.public_key)).not.toContain(old);
  const added = keys.find((k) => k.public_key === next);
  expect(JSON.stringify(added?.access_key.permission)).toContain("2000000000000000000000000");
});
