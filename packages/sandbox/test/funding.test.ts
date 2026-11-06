/**
 * Seam 2 for ticket #8: the Owner funds the Allowance with transfer-and-notify, sees
 * where the money is, and Withdraws real USDC up to the balance minus Held.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { getBudget, newRequestId, requestSpend } from "../src/agent.js";
import { NEAR, TGAS, USDC, USDC_STORAGE_DEPOSIT, startHarness, type Harness } from "../src/harness.js";
import { readContracts } from "../src/contracts.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    allowanceUsdc: 100n * USDC,
    policy: {
      daily_cap: (100n * USDC).toString(),
      auto_limit: (5n * USDC).toString(),
      hard_ceiling: (50n * USDC).toString(),
      velocity_limit: 10,
      max_timeout_blocks: 120,
    },
  });
});

afterAll(async () => {
  await h?.stop();
});

async function withdraw(amount: bigint): Promise<void> {
  await h.owner.callFunction({
    contractId: h.allowance.accountId,
    methodName: "withdraw",
    args: { amount: amount.toString() },
    deposit: 1n,
    gas: 100n * TGAS,
  });
}

test("a transfer-and-notify deposit is credited and shows in the budget view", async () => {
  expect(await getBudget(h)).toMatchObject({
    usdc_balance: (100n * USDC).toString(),
    held: "0",
    withdrawable: (100n * USDC).toString(),
  });

  await h.depositUsdc(h.owner, 10n * USDC);

  const budget = await getBudget(h);
  expect(budget.usdc_balance).toBe((110n * USDC).toString());
  expect(BigInt(budget.usdc_balance)).toBe(await h.usdcBalance(h.allowance.accountId));
  expect(BigInt(budget.near_balance)).toBeGreaterThan(NEAR);
});

test("another token sent with transfer-and-notify is refunded and credits nothing", async () => {
  const fake = await h.createAccount("fakeusdc", 10n);
  await fake.deployContract(readContracts().usdc);
  await fake.callFunction({
    contractId: fake.accountId,
    methodName: "new",
    args: { owner_id: h.owner.accountId, total_supply: (1_000n * USDC).toString() },
  });
  await h.owner.callFunction({
    contractId: fake.accountId,
    methodName: "storage_deposit",
    args: { account_id: h.allowance.accountId, registration_only: true },
    deposit: USDC_STORAGE_DEPOSIT,
    gas: 30n * TGAS,
  });
  const before = await getBudget(h);

  await h.owner.callFunction({
    contractId: fake.accountId,
    methodName: "ft_transfer_call",
    args: { receiver_id: h.allowance.accountId, amount: (50n * USDC).toString(), msg: "" },
    deposit: 1n,
    gas: 60n * TGAS,
  });

  const fakeBalance = async (accountId: string) =>
    BigInt(await h.view<string>(fake.accountId, "ft_balance_of", { account_id: accountId }));
  expect(await fakeBalance(h.owner.accountId)).toBe(1_000n * USDC);
  expect(await fakeBalance(h.allowance.accountId)).toBe(0n);
  expect((await getBudget(h)).usdc_balance).toBe(before.usdc_balance);
});

test("a Pending spend is Held and cuts Withdrawable; Withdraw stops at the limit and moves real USDC to the Owner", async () => {
  const pending = await requestSpend(h, {
    request_id: newRequestId(),
    payee: h.payee.accountId,
    amount: 30n * USDC,
    max_timeout_blocks: 60,
  });
  expect(pending.status).toBe("Pending");
  const balance = BigInt((await getBudget(h)).usdc_balance);
  expect(await getBudget(h)).toMatchObject({
    held: (30n * USDC).toString(),
    withdrawable: (balance - 30n * USDC).toString(),
  });
  const withdrawable = balance - 30n * USDC;

  await expect(withdraw(withdrawable + 1n)).rejects.toThrow("amount exceeds Withdrawable");

  const ownerBefore = await h.usdcBalance(h.owner.accountId);
  await withdraw(withdrawable);

  expect(await h.usdcBalance(h.owner.accountId)).toBe(ownerBefore + withdrawable);
  expect(await h.usdcBalance(h.allowance.accountId)).toBe(30n * USDC);
  expect(await getBudget(h)).toMatchObject({
    usdc_balance: (30n * USDC).toString(),
    held: (30n * USDC).toString(),
    withdrawable: "0",
  });
});
