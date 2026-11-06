/**
 * Seam 2 for ticket #5: concurrent split Spend Requests on a real chain can never
 * reserve, or pay out, more than the Daily Cap.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { getBudget, newRequestId, requestSpend, waitForPayment } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    policy: {
      daily_cap: (20n * USDC).toString(),
      auto_limit: (5n * USDC).toString(),
      hard_ceiling: (50n * USDC).toString(),
      velocity_limit: 100,
      max_timeout_blocks: 120,
    },
    // A signing key for each of the six spends that fit the cap, so none is refused as busy.
    payerKeys: 6,
  });
});

afterAll(async () => {
  await h?.stop();
});

test("ten concurrent $3 requests: six are Approved, the rest Blocked, and exactly $18 leaves", async () => {
  const allowanceBefore = await h.usdcBalance(h.allowance.accountId);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      requestSpend(h, { request_id: newRequestId(), payee: h.payee.accountId, amount: 3n * USDC, max_timeout_blocks: 60 }),
    ),
  );

  const approved = results.filter((r) => r.outcome === "Approved");
  const blocked = results.filter((r) => r.outcome === "Blocked");
  expect(approved).toHaveLength(6);
  expect(blocked.map((r) => r.blocked_reason)).toEqual(Array(4).fill("DailyCapExceeded"));
  expect(blocked[0]!.limit).toMatchObject({ limit: (20n * USDC).toString() });

  for (const r of approved) expect((await waitForPayment(h, r.request_id)).status).toBe("Signed");
  expect(await h.usdcBalance(h.allowance.accountId)).toBe(allowanceBefore - 18n * USDC);
  expect(await getBudget(h)).toMatchObject({
    used_in_window: (18n * USDC).toString(),
    available: (2n * USDC).toString(),
    velocity_used: 6,
  });
});
