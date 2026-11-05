/**
 * Seam 2 for ticket #4: Spend Requests against a real (sandbox) chain. Approved spends
 * settle through the official facilitator; Blocked ones never reach the signer or move
 * money; the Agent's key can do nothing but submit Spend Requests.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { allowanceFetch, newRequestId, requestSpend, waitForPayment } from "../src/agent.js";
import { TGAS, USDC, startHarness, type Harness } from "../src/harness.js";
import { startSeller, type Seller } from "seller";

let h: Harness;
let seller: Seller;
let hugeSeller: Seller;
let attackerSeller: Seller;

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
  const attacker = await h.createAccount("attacker", 2n);
  await h.registerUsdc(attacker.accountId);
  seller = await startSeller({
    facilitator: h.facilitator,
    payTo: h.payee.accountId,
    asset: h.usdc.accountId,
  });
  hugeSeller = await startSeller({
    facilitator: h.facilitator,
    payTo: h.payee.accountId,
    asset: h.usdc.accountId,
    prices: { report: "$51" },
  });
  attackerSeller = await startSeller({
    facilitator: h.facilitator,
    payTo: attacker.accountId,
    asset: h.usdc.accountId,
    prices: { weather: "$1" },
  });
});

afterAll(async () => {
  await seller?.close();
  await attackerSeller?.close();
  await hugeSeller?.close();
  await h?.stop();
});

/** Everything a Blocked request must leave untouched. */
async function moneyAndSigner() {
  return {
    allowance: await h.usdcBalance(h.allowance.accountId),
    payer: await h.usdcBalance(h.payerAccountId),
    signatures: await h.view<unknown[]>(h.signer.accountId, "pending_requests"),
  };
}

test("an Approved spend is paid with a Signed Payment the seller's facilitator settles", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const response = await allowanceFetch(h)(`${seller.url}/weather`);
  expect(response.status).toBe(200);
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + USDC / 2n);
});

test("paying an unknown Payee is Blocked and never reaches the signer", async () => {
  await h.stopResponder(); // so a signature request would stay visible
  try {
    const before = await moneyAndSigner();
    const ids: string[] = [];
    const response = allowanceFetch(h, (id) => ids.push(id))(`${attackerSeller.url}/weather`);
    await expect(response).rejects.toThrow(/UnknownPayee/);
    expect(await moneyAndSigner()).toEqual(before);
    expect(await h.view(h.allowance.accountId, "get_request", { request_id: ids[0] })).toMatchObject({
      outcome: "Blocked",
      blocked_reason: "UnknownPayee",
    });
  } finally {
    h.startResponder();
  }
});

test("a spend over the Hard Ceiling is Blocked and moves nothing", async () => {
  const before = await moneyAndSigner();
  await expect(allowanceFetch(h)(`${hugeSeller.url}/report`)).rejects.toThrow(/OverHardCeiling/);
  expect(await moneyAndSigner()).toEqual(before);
});

test("a spend above the Auto Limit waits for the Owner and moves nothing", async () => {
  const before = await moneyAndSigner();
  const failure = await allowanceFetch(h)(`${seller.url}/report`).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  const cause = (failure as Error).cause ?? failure;
  expect(String(cause)).toMatch(/Pending/);
  expect(await moneyAndSigner()).toEqual(before);
});

test("an identical retry returns the same Signed Payment; changed details are an IdempotencyConflict", async () => {
  const args = { request_id: newRequestId(), payee: h.payee.accountId, amount: USDC, memo: "retry", max_timeout_blocks: 60 };
  await requestSpend(h, args);
  const signed = await waitForPayment(h, args.request_id);
  expect(signed.status).toBe("Signed");

  expect(await requestSpend(h, args)).toEqual(signed);
  const conflict = await requestSpend(h, { ...args, amount: 2n * USDC });
  expect(conflict).toMatchObject({ outcome: "Blocked", blocked_reason: "IdempotencyConflict" });
  expect(await waitForPayment(h, args.request_id)).toEqual(signed);
});

test("the Agent's key can only submit Spend Requests", async () => {
  // Methods anyone with a full-access key on this account could call: the key's method
  // restriction is the only thing stopping these.
  for (const method of ["get_policy", "get_allowlist", "payer_keys"]) {
    await expect(
      h.agent.callFunction({ contractId: h.allowance.accountId, methodName: method, args: {}, gas: 30n * TGAS }),
    ).rejects.toThrow(/does not allow method/);
  }
  // And it can't call any other contract, so it can't move USDC directly.
  await expect(
    h.agent.callFunction({
      contractId: h.usdc.accountId,
      methodName: "ft_transfer",
      args: { receiver_id: "attacker.sandbox", amount: "1" },
      deposit: 1n,
      gas: 30n * TGAS,
    }),
  ).rejects.toThrow();
});
