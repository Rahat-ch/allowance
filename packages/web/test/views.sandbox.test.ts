/**
 * The data layer against the real contract on a sandbox: the views parse what the
 * Allowance actually returns, and the Owner calls the page builds do what they should
 * when the Owner signs them (here with the Owner's key instead of a wallet).
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { newRequestId, requestSpend } from "sandbox/agent";
import { HOUR_NS, USDC, startHarness, type Harness } from "sandbox/harness";
import { AllowanceViews, explainError, ownerCalls, type OwnerCall } from "../src/allowance.js";

/** A near-api-js 7 account from the harness (this package's own near-api-js is Meteor's v6). */
type Account = Harness["owner"];

let h: Harness;
let views: AllowanceViews;

beforeAll(async () => {
  h = await startHarness({ allowanceUsdc: 600n * USDC });
  views = new AllowanceViews(h.rpcUrl, h.allowance.accountId);
});

afterAll(async () => {
  await h?.stop();
});

/** Signs `call` as `account`, the way the page's wallet would. */
function send(call: OwnerCall, account: Account = h.owner) {
  return account.callFunction({
    contractId: h.allowance.accountId,
    methodName: call.methodName,
    args: call.args,
    gas: call.gas,
    deposit: call.deposit,
  });
}

/** The page's explanation of why `call` failed. */
async function failure(call: OwnerCall, account?: Account): Promise<string> {
  try {
    await send(call, account);
  } catch (e) {
    return explainError(e);
  }
  throw new Error(`${call.methodName} unexpectedly succeeded`);
}

const spend = (amount: bigint, memo?: string) =>
  requestSpend(h, { request_id: newRequestId(), payee: h.payee.accountId, amount, memo, max_timeout_blocks: 60 });

let first: string;
let second: string;

test("the snapshot reads the Owner, status, Policy and an empty queue", async () => {
  const s = await views.snapshot();
  expect(s).toMatchObject({ owner: h.owner.accountId, paused: false, revoked: false, pending: [], allowlist: [h.payee.accountId] });
  expect(s.policy).toEqual({
    dailyCap: 1_000n * USDC,
    autoLimit: 100n * USDC,
    hardCeiling: 500n * USDC,
    velocityLimit: 1_000,
    maxTimeoutBlocks: 600,
  });
  expect(s.budget).toMatchObject({ usedInWindow: 0n, available: 1_000n * USDC, nextReleaseNs: null, usdcBalance: 600n * USDC, held: 0n });
  expect(s.budget.nearBalance).toBeGreaterThan(0n);
});

test("Pending spends list oldest first with amount, Payee, memo and Expiry", async () => {
  first = (await spend(150n * USDC, "weather API")).request_id;
  second = (await spend(120n * USDC)).request_id;
  expect((await spend(5n * USDC)).outcome).toBe("Approved"); // under the Auto Limit: never listed

  const pending = await views.listPending();
  expect(pending.map((r) => r.requestId)).toEqual([first, second]);
  const [a] = pending;
  expect(a).toMatchObject({ payee: h.payee.accountId, amount: 150n * USDC, memo: "weather API", status: "Pending", pickupDeadlineNs: null });
  expect(pending[1]?.memo).toBeNull();
  const now = Number(await h.chainTime());
  expect(a!.requestedAtNs).toBeLessThanOrEqual(now);
  // 24 hours to decide (ns, give or take JSON's lost precision).
  expect(Math.abs(a!.expiresAtNs! - a!.requestedAtNs - Number(24n * HOUR_NS))).toBeLessThan(1e6);
});

test("the budget counts Reservations, Held and when capacity frees", async () => {
  const b = await views.getBudget();
  expect(b.usedInWindow).toBe(275n * USDC); // both Pending + the $5 paid
  expect(b.available).toBe(725n * USDC);
  expect(b.held).toBe(270n * USDC);
  expect(b.usdcBalance).toBe(595n * USDC); // the $5 left for the Payer Account
  expect(b.withdrawable).toBe(325n * USDC);
  expect(b.velocityUsed).toBe(3);
  expect(b.nextReleaseNs).not.toBeNull();
  expect(b.nextReleaseNs!).toBeGreaterThan(Number(await h.chainTime()) + Number(23n * HOUR_NS));
});

test("approve moves a spend to approved-awaiting-Pickup; deciding it again is explained", async () => {
  await send(ownerCalls.approve(first));
  const approved = (await views.listPending()).find((r) => r.requestId === first);
  expect(approved).toMatchObject({ status: "Approved" });
  expect(approved!.pickupDeadlineNs! - Number(await h.chainTime())).toBeGreaterThan(Number(HOUR_NS) - 60e9);

  expect(await failure(ownerCalls.approve(first))).toMatch(/already decided/);
  expect(await failure(ownerCalls.reject("req_does_not_exist_0001"))).toMatch(/No such Spend Request/);
});

test("only the Owner can decide", async () => {
  expect(await failure(ownerCalls.reject(second), h.payee)).toMatch(/Only the Owner/);
});

test("reject releases the Reservation and Held funds", async () => {
  await send(ownerCalls.reject(second));
  expect((await views.listPending()).map((r) => r.requestId)).toEqual([first]);
  expect(await views.getRequest(second)).toMatchObject({ status: "Rejected", amount: 120n * USDC });
  expect((await views.getBudget()).held).toBe(150n * USDC);
});

test("Pause, unpause and Revoke as the page sends them", async () => {
  await send(ownerCalls.pause());
  expect(await views.isPaused()).toBe(true);
  await send(ownerCalls.unpause());
  expect(await views.isPaused()).toBe(false);

  await send(ownerCalls.revoke());
  const s = await views.snapshot();
  expect(s.revoked).toBe(true);
  expect(s.pending).toEqual([]);
  expect(await views.getRequest(first)).toMatchObject({ status: "Cancelled" });
  expect(await failure(ownerCalls.revoke())).toMatch(/already revoked/);
});
