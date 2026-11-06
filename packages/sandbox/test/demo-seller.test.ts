/**
 * Ticket #12: the demo seller (packages/seller), paid through the Allowance and
 * settled by the official NEAR facilitator against the sandbox.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { startSeller, type Seller } from "seller";
import { allowanceFetch } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;
let seller: Seller;

beforeAll(async () => {
  // One signing key per Signed Payment this file issues within one payment's validity.
  h = await startHarness({ payerKeys: 3 });
  seller = await startSeller({ facilitator: h.facilitator, payTo: h.payee.accountId, asset: h.usdc.accountId });
});

afterAll(async () => {
  await seller?.close();
  await h?.stop();
});

function decode(header: string | null): any {
  expect(header).toBeTruthy();
  return JSON.parse(Buffer.from(header!, "base64").toString());
}

/** `allowanceFetch` that also records the PAYMENT-SIGNATURE headers it sends. */
function recordingFetch(): { fetch: typeof fetch; signatures: string[] } {
  const signatures: string[] = [];
  const base: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const signature = request.headers.get("payment-signature");
    if (signature) signatures.push(signature);
    return fetch(request);
  };
  return { fetch: allowanceFetch(h, undefined, base), signatures };
}

test("an unpaid premium report gets a 402 offering exact USDC on NEAR for $15", async () => {
  const response = await fetch(`${seller.url}/report`);
  expect(response.status).toBe(402);
  const required = decode(response.headers.get("payment-required"));
  expect(required.x402Version).toBe(2);
  expect(required.accepts).toEqual([
    expect.objectContaining({
      scheme: "exact",
      network: "near:testnet",
      asset: h.usdc.accountId,
      amount: "15000000",
      payTo: h.payee.accountId,
      maxTimeoutSeconds: 60,
    }),
  ]);
});

test("a paid premium report returns 200 with PAYMENT-RESPONSE, and the Payee gets $15", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const response = await allowanceFetch(h)(`${seller.url}/report`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ title: expect.stringContaining("Premium report") });
  expect(decode(response.headers.get("payment-response"))).toMatchObject({
    success: true,
    network: "near:testnet",
    payer: h.payerAccountId,
  });
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + 15n * USDC);
});

test("replaying a used payment is refused and moves no funds", async () => {
  const { fetch: paidFetch, signatures } = recordingFetch();
  const paid = await paidFetch(`${seller.url}/weather?city=Oslo`);
  expect(paid.status).toBe(200);
  expect(await paid.json()).toMatchObject({ city: "Oslo" });
  expect(signatures).toHaveLength(1);

  const before = await h.usdcBalance(h.payee.accountId);
  const replay = await fetch(`${seller.url}/weather?city=Oslo`, { headers: { "PAYMENT-SIGNATURE": signatures[0]! } });
  expect(replay.status).toBe(402);
  expect(replay.headers.get("payment-response")).toBeNull();
  // The facilitator sees the delegate action's nonce is already used on chain.
  expect(decode(replay.headers.get("payment-required")).error).toMatch(/nonce_already_used/);
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before);
});

test("a seller configured with another Payee and price is paid exactly that", async () => {
  const otherPayee = await h.createAccount("shop", 5n);
  await h.registerUsdc(otherPayee.accountId);
  await h.addPayee(otherPayee.accountId); // the Owner trusts the new shop
  const other = await startSeller({
    facilitator: h.facilitator,
    payTo: otherPayee.accountId,
    asset: h.usdc.accountId,
    prices: { weather: "$1.25" },
    maxTimeoutSeconds: 90,
  });
  try {
    const offer = decode((await fetch(`${other.url}/weather`)).headers.get("payment-required")).accepts[0];
    expect(offer).toMatchObject({ amount: "1250000", payTo: otherPayee.accountId, maxTimeoutSeconds: 90 });

    const payeeBefore = await h.usdcBalance(h.payee.accountId);
    const response = await allowanceFetch(h)(`${other.url}/weather`);
    expect(response.status).toBe(200);
    expect(await h.usdcBalance(otherPayee.accountId)).toBe(1_250_000n);
    expect(await h.usdcBalance(h.payee.accountId)).toBe(payeeBefore);
  } finally {
    await other.close();
  }
});
