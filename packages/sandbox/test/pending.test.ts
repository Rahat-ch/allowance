/**
 * Seam 2 for ticket #7: a spend above the Auto Limit waits for the Owner; once approved
 * the Agent picks up its Signed Payment by re-submitting the Request ID and the seller
 * is paid. A lapsed approval can't be picked up.
 */
import { startSeller, type Seller } from "seller";
import { afterAll, beforeAll, expect, test } from "vitest";
import { allowanceFetch, getBudget, getRequest, type SpendRequest } from "../src/agent.js";
import { HOUR_NS, USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;
let seller: Seller;

beforeAll(async () => {
  h = await startHarness({
    policy: {
      daily_cap: (20n * USDC).toString(),
      auto_limit: (5n * USDC).toString(),
      hard_ceiling: (50n * USDC).toString(),
      velocity_limit: 10,
      max_timeout_blocks: 120,
    },
  });
  seller = await startSeller({ facilitator: h.facilitator, payTo: h.payee.accountId, asset: h.usdc.accountId });
});

afterAll(async () => {
  await seller?.close();
  await h?.stop();
});

/** Runs a paid call that must not be paid, and returns the Spend Request it made. */
async function notPaid(call: (onRequest: (id: string) => void) => Promise<Response>): Promise<SpendRequest> {
  let requestId: string | undefined;
  await expect(call((id) => (requestId = id))).rejects.toThrow(/not paid/);
  return (await getRequest(h, requestId!))!;
}

async function ownerCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return h.ownerCall<T>(method, args);
}

test("Pending, then the Owner approves, then the Agent picks it up and the seller is paid", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const pending = await notPaid((on) => allowanceFetch(h, on)(`${seller.url}/report`));
  const ids = [pending.request_id];
  expect(pending).toMatchObject({ outcome: "Pending", status: "Pending" });
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before);
  expect((await getBudget(h)).used_in_window).toBe((15n * USDC).toString());

  const approved = await ownerCall<SpendRequest>("approve", { request_id: ids[0] });
  expect(approved.status).toBe("Approved");

  const response = await allowanceFetch(h, undefined, fetch, ids[0])(`${seller.url}/report`);
  expect(response.status).toBe(200);
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + 15n * USDC);
  expect(await getRequest(h, ids[0]!)).toMatchObject({ outcome: "Pending", status: "Signed" });
});

/** The first test spends $15 of the $20 cap; later tests need room. */
async function roomyCap(): Promise<void> {
  await ownerCall("set_policy", {
    policy: {
      daily_cap: (100n * USDC).toString(),
      auto_limit: (5n * USDC).toString(),
      hard_ceiling: (50n * USDC).toString(),
      velocity_limit: 10,
      max_timeout_blocks: 120,
    },
  });
}

test("a rejected spend releases its Reservation and can't be picked up", async () => {
  await roomyCap();
  const ids = [(await notPaid((on) => allowanceFetch(h, on)(`${seller.url}/report`))).request_id];
  const usedWhilePending = BigInt((await getBudget(h)).used_in_window);
  await ownerCall("reject", { request_id: ids[0] });
  expect(BigInt((await getBudget(h)).used_in_window)).toBe(usedWhilePending - 15n * USDC);
  const retry = await notPaid((on) => allowanceFetch(h, on, fetch, ids[0])(`${seller.url}/report`));
  expect(retry.status).toBe("Rejected");
});

// Fast-forwarding an hour of chain time takes ~2 minutes; the contract tests cover Lapse.
test.skipIf(!process.env.SANDBOX_SLOW)("an approval not picked up within the hour lapses", { timeout: 600_000 }, async () => {
  const ids = [(await notPaid((on) => allowanceFetch(h, on)(`${seller.url}/report`))).request_id];
  await ownerCall("approve", { request_id: ids[0] });
  await h.fastForwardTime(HOUR_NS + 60_000_000_000n);
  const lapsed = await notPaid((on) => allowanceFetch(h, on, fetch, ids[0])(`${seller.url}/report`));
  expect(lapsed.status).toBe("Lapsed");
});
