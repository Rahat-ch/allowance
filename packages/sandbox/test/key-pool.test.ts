/**
 * Seam 2 for ticket #6: each outstanding Signed Payment leases a Payer Account key of its
 * own, so concurrent payments all settle; with every key leased the next Spend Request is
 * refused as busy (nothing stored or reserved) and the same Request ID works once a key's
 * payment has expired.
 *
 * Each seller here has its own facilitator: the official NEAR facilitator settles through
 * its first relayer key only, so two settlements racing through one facilitator collide on
 * the relayer's transaction nonce ("nonce must be larger than nonce of the used access
 * key"), whoever signed the payments. That is the facilitator's limit, not the payments'.
 */
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  BUSY,
  allowanceFetch,
  getBudget,
  getKeyPool,
  getRequest,
  newRequestId,
  requestSpend,
  waitForPayment,
} from "../src/agent.js";
import { createFacilitator } from "../src/facilitator.js";
import { NEAR, USDC, startHarness, type Harness } from "../src/harness.js";
import { startSeller, type Seller } from "seller";

const KEYS = 3;

let h: Harness;
const sellers: Seller[] = [];

beforeAll(async () => {
  h = await startHarness({ payerKeys: KEYS });
  for (let i = 0; i < KEYS; i++) {
    const relayer = KeyPair.fromRandom("ed25519");
    const accountId = `relayer${i}.${h.root.accountId}`;
    await h.root.createSubAccount({ accountOrPrefix: accountId, publicKey: relayer.getPublicKey(), nearToTransfer: 5n * NEAR });
    const facilitator = createFacilitator({
      relayer: { accountId, secretKey: relayer.toString() as `ed25519:${string}` },
      rpcUrl: h.rpcUrl,
    });
    sellers.push(await startSeller({ facilitator, payTo: h.payee.accountId, asset: h.usdc.accountId }));
  }
});

afterAll(async () => {
  await Promise.all(sellers.map((s) => s.close()));
  await h?.stop();
});

const paid: string[] = [];

test("concurrent Signed Payments each lease their own key and all settle", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const responses = await Promise.all(
    sellers.map((seller) => allowanceFetch(h, (id) => paid.push(id))(`${seller.url}/weather`)),
  );
  expect(responses.map((r) => r.status)).toEqual(Array(KEYS).fill(200));
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + BigInt(KEYS) * (USDC / 2n));

  const keys = await Promise.all(paid.map(async (id) => (await getRequest(h, id))!.payment!.key_index));
  expect(keys.sort()).toEqual([0, 1, 2]);
});

test("with every key leased the next spend is busy, changes nothing, and succeeds once a lease expires", async () => {
  const pool = await getKeyPool(h);
  expect(pool).toMatchObject({ keys: KEYS, free: 0 });
  const budgetBefore = await getBudget(h);
  const args = { request_id: newRequestId(), payee: h.payee.accountId, amount: USDC, max_timeout_blocks: 60 };

  await expect(requestSpend(h, args)).rejects.toThrow(BUSY);
  expect(await getRequest(h, args.request_id)).toBeNull();
  expect(await getBudget(h)).toEqual(budgetBefore);

  // Past the earliest payment's max_block_height its key is free again.
  await h.fastForward(pool.next_free_height! - (await h.finalHeight()) + 5);
  expect((await getKeyPool(h)).free).toBeGreaterThan(0);

  const retry = await requestSpend(h, args);
  expect(retry).toMatchObject({ outcome: "Approved", status: "Funding" });
  const signed = await waitForPayment(h, args.request_id);
  expect(signed.status).toBe("Signed");
  const previous = await Promise.all(paid.map((id) => getRequest(h, id)));
  const sameKey = previous.find((r) => r!.payment!.key_index === signed.payment!.key_index)!;
  expect(signed.payment!.nonce).toBeGreaterThan(sameKey.payment!.nonce);
});
