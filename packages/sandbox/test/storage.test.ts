/**
 * Seam 2 for ticket #10: a flood of Blocked Spend Requests can't drain the Allowance's
 * NEAR through storage. Only a per-hour budget of them is stored; the rest are events.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { requestSpend, type SpendRequest } from "../src/agent.js";
import { NEAR, TGAS, USDC, startHarness, type Harness } from "../src/harness.js";

/** Mirrors BLOCKED_RECORDS_PER_HOUR in contracts/allowance/src/storage.rs. */
const BLOCKED_RECORDS_PER_HOUR = 20;
const HOUR_NS = 3_600_000_000_000n;
/** NEAR's storage staking price: 1 NEAR per 100 kB. */
const YOCTO_PER_BYTE = 10n ** 19n;
/** NEAR the Allowance keeps free of storage staking: a little, as an Owner would fund it. */
const FREE_NEAR = (6n * NEAR) / 10n;
const FLOOD = 200;
const BATCH = 20;
const FLOOD_GAS = 15n * TGAS;

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

async function account() {
  const a = await h.provider.viewAccount({ accountId: h.allowance.accountId });
  const staked = BigInt(a.storage_usage) * YOCTO_PER_BYTE;
  return { storage: a.storage_usage, amount: a.amount, free: a.amount - staked };
}

test("a flood of Blocked requests stores only the hourly budget and the Owner can still act", async () => {
  // Leave the Allowance only FREE_NEAR. Stored, these 200 maximal records (~611 bytes each)
  // would need ~1.2 NEAR of storage staking: without the budget the flood starves it.
  await h.allowance.transfer({ receiverId: h.root.accountId, amount: (await account()).free - FREE_NEAR });
  const attacker = `attacker.${h.root.accountId}`;
  const before = await account();

  // Maximal records: 128-character Request IDs and 64-byte memos, BATCH at a time.
  const flood: SpendRequest[] = [];
  for (let batch = 0; batch < FLOOD / BATCH; batch++) {
    flood.push(
      ...(await Promise.all(
        Array.from({ length: BATCH }, (_, i) =>
          requestSpend(h, {
            request_id: `flood-${batch}-${i}-`.padEnd(128, "x"),
            payee: attacker,
            amount: USDC,
            memo: "m".repeat(64),
            max_timeout_blocks: 60,
            // As little gas as a Blocked request needs: an attacker wastes none on prepaying.
            gas: FLOOD_GAS,
          }),
        ),
      )),
    );
  }
  const after = await account();

  expect(flood.map((r) => r.blocked_reason)).toEqual(Array(FLOOD).fill("UnknownPayee"));
  // The flood may straddle an hour boundary: each hour stores exactly its budget.
  const byHour = new Map<bigint, SpendRequest[]>();
  for (const r of flood) {
    const hour = BigInt(r.requested_at_ns) / HOUR_NS;
    byHour.set(hour, [...(byHour.get(hour) ?? []), r]);
  }
  for (const requests of byHour.values()) {
    expect(requests.filter((r) => r.stored)).toHaveLength(Math.min(requests.length, BLOCKED_RECORDS_PER_HOUR));
  }
  const stored = flood.filter((r) => r.stored);
  const unstored = flood.filter((r) => !r.stored);
  for (const r of [...stored, unstored[0]!, unstored.at(-1)!]) {
    expect(await h.view(h.allowance.accountId, "get_request", { request_id: r.request_id })).toEqual(r.stored ? r : null);
  }

  const grown = after.storage - before.storage;
  console.log(
    `flood of ${FLOOD}: ${stored.length} stored, ${grown} bytes (${grown / stored.length} per record); ` +
      `free NEAR ${Number(before.free) / 1e24} -> ${Number(after.free) / 1e24}`,
  );
  expect(grown).toBeLessThanOrEqual(stored.length * 640);
  // Most of the little NEAR is left: the budget's storage plus the Agent's gas.
  expect(after.free).toBeGreaterThan(FREE_NEAR / 2n);

  // The Owner still acts. (approve, Withdraw, Pause and Revoke land with #7 and #8;
  // add_payee is the Owner method that grows storage today.)
  await h.addPayee(attacker);
  expect(await h.view<string[]>(h.allowance.accountId, "get_allowlist")).toContain(attacker);
});
