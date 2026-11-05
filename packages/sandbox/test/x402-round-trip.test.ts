/**
 * Seam 2: an x402 seller running the official middleware is paid by a Signed
 * Payment the Allowance built and had signed, settled by the official NEAR
 * facilitator against the sandbox.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { allowanceFetch, getSignedPayment } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";
import { startSeller, type Seller } from "../src/seller.js";

let h: Harness;
let seller: Seller;

beforeAll(async () => {
  h = await startHarness();
  seller = await startSeller({
    facilitator: h.facilitator,
    payTo: h.payee.accountId,
    asset: h.usdc.accountId,
    routes: { "GET /data": "$0.50" },
  });
});

afterAll(async () => {
  await seller?.close();
  await h?.stop();
});

test("an unpaid call gets a 402 offering exact USDC on NEAR", async () => {
  const response = await fetch(`${seller.url}/data`);
  expect(response.status).toBe(402);
  const required = JSON.parse(Buffer.from(response.headers.get("payment-required")!, "base64").toString());
  expect(required.accepts).toEqual([
    expect.objectContaining({
      scheme: "exact",
      network: "near:testnet",
      asset: h.usdc.accountId,
      amount: "500000",
      payTo: h.payee.accountId,
    }),
  ]);
});

test("a Signed Payment from the Allowance is verified and settled, and the Payee gets exactly the amount", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const requestIds: string[] = [];

  const response = await allowanceFetch(h, (id) => requestIds.push(id))(`${seller.url}/data`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, route: "GET /data" });
  const settlement = JSON.parse(Buffer.from(response.headers.get("payment-response")!, "base64").toString());
  expect(settlement).toMatchObject({ success: true, network: "near:testnet", payer: h.payerAccountId });
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + USDC / 2n);
  expect(requestIds).toHaveLength(1);
  expect((await getSignedPayment(h, requestIds[0]!))?.status).toBe("Signed");
});
