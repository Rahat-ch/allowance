/**
 * Seam 2 for ticket #21: Signed Payments nobody collects leave their USDC in the Payer
 * Account. Once they expire, the Owner's script sweeps it back: the Allowance signs an
 * `ft_transfer_call` delegate from the Payer Account, a relayer submits it, and the USDC is
 * credited and Withdrawable again. While a payment is still valid its USDC can't be swept.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { getSweep, requestSweep, sweepAndRelay, waitForSweep } from "deploy/sweep";
import { getBudget, getKeyPool, newRequestId, requestSpend, waitForPayment } from "../src/agent.js";
import { TGAS, USDC, startHarness, type Harness } from "../src/harness.js";

/** The contract's SETTLEMENT_SLACK_BLOCKS: a just-expired payment is deducted this long. */
const SETTLEMENT_SLACK_BLOCKS = 40;

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ payerKeys: 2, allowanceUsdc: 100n * USDC });
});

afterAll(async () => {
  await h?.stop();
});

/** max_block_height of every uncollected payment issued so far. */
const expiries: number[] = [];

/** A Signed Payment the Agent never hands to a seller. */
async function uncollectedPayment(amount: bigint) {
  const requestId = newRequestId();
  const submitted = await requestSpend(h, { request_id: requestId, payee: h.payee.accountId, amount, max_timeout_blocks: 60 });
  expect(submitted.outcome).toBe("Approved");
  const signed = await waitForPayment(h, requestId);
  expect(signed.status).toBe("Signed");
  expiries.push(signed.payment!.max_block_height);
  return signed.payment!;
}

const sweepGas = 150n * TGAS;
const usedInWindow = async () => (await getBudget(h)).used_in_window;

test("while a Signed Payment is still valid its USDC can't be swept", async () => {
  const first = await uncollectedPayment(3n * USDC);
  expect(await h.usdcBalance(h.payerAccountId)).toBe(3n * USDC);

  // A free key, but the only USDC in the Payer Account belongs to a valid payment.
  const id = await requestSweep(h.owner, h.allowance.accountId);
  const refused = await waitForSweep(h.owner, h.allowance.accountId, id, { pollMs: 250 });
  expect(refused).toMatchObject({ status: "Refused", payer_balance: (3n * USDC).toString(), outstanding: (3n * USDC).toString() });
  expect(refused.refused_reason).toContain("nothing to sweep");

  // With every key holding a valid payment the sweep is refused outright.
  const second = await uncollectedPayment(4n * USDC);
  expect((await getKeyPool(h)).free).toBe(0);
  await expect(h.ownerCall("sweep", { amount: null }, sweepGas)).rejects.toThrow(/busy: all signing keys are in use/);
  expect(await getSweep(h.owner, h.allowance.accountId, id + 1)).toBeNull();

  expect(await h.usdcBalance(h.payerAccountId)).toBe(7n * USDC);
  expect([first.key_index, second.key_index].sort()).toEqual([0, 1]);
});

test("after expiry the Owner's script sweeps the uncollected USDC back, and the Owner can Withdraw it", async () => {
  expect(expiries).toHaveLength(2);
  const lastExpiry = Math.max(...expiries);
  await h.fastForward(lastExpiry - (await h.finalHeight()) + SETTLEMENT_SLACK_BLOCKS + 5);
  expect((await getKeyPool(h)).free).toBe(2);

  const before = await getBudget(h);
  const capBefore = await usedInWindow();
  expect(before.usdc_balance).toBe((93n * USDC).toString());
  const relayerUsdcBefore = await h.usdcBalance(h.relayer.accountId);

  const { sweep, relayTxHash } = await sweepAndRelay(h.owner, h.relayer, h.allowance.accountId, { pollMs: 250 });
  expect(relayTxHash).toBeTruthy();
  expect(sweep).toMatchObject({ status: "Settled", amount: (7n * USDC).toString(), outstanding: "0" });

  // The USDC really moved, and the ledger credited it.
  expect(await h.usdcBalance(h.payerAccountId)).toBe(0n);
  expect(await h.usdcBalance(h.allowance.accountId)).toBe(100n * USDC);
  expect(await getBudget(h)).toMatchObject({
    usdc_balance: (100n * USDC).toString(),
    held: "0",
    withdrawable: (100n * USDC).toString(),
  });
  // Only funds are recovered: the swept payments still count against the Daily Cap.
  expect(await usedInWindow()).toBe(capBefore);
  expect(capBefore).toBe((7n * USDC).toString());
  // The relayer only paid gas.
  expect(await h.usdcBalance(h.relayer.accountId)).toBe(relayerUsdcBefore);
  // Settling gave the sweep's key back at once.
  expect((await getKeyPool(h)).free).toBe(2);

  const ownerBefore = await h.usdcBalance(h.owner.accountId);
  await h.ownerCall("withdraw", { amount: (100n * USDC).toString() });
  expect(await h.usdcBalance(h.owner.accountId)).toBe(ownerBefore + 100n * USDC);
  expect((await getBudget(h)).usdc_balance).toBe("0");
});
