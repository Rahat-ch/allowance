import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, test } from "vitest";
import { formatUsd, selectOffer, usdToBaseUnits } from "../src/offers.js";

const USDC = "usdc.allowance.testnet";
const offer = (o: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "near:testnet",
  asset: USDC,
  amount: "500000",
  payTo: "seller.testnet",
  maxTimeoutSeconds: 60,
  extra: {},
  ...o,
});
const wanted = { network: "near:testnet", asset: USDC, maxAmount: 1_000_000n };

describe("selectOffer", () => {
  test("picks the exact offer on the Allowance's network in its asset", () => {
    const evm = offer({ network: "eip155:8453", asset: "0xabc" });
    const choice = selectOffer([evm, offer()], wanted);
    expect(choice).toEqual({ ok: true, offer: offer() });
  });

  test("picks the cheapest qualifying offer", () => {
    const choice = selectOffer([offer({ amount: "900000" }), offer({ amount: "400000" })], wanted);
    expect(choice.ok && choice.offer.amount).toBe("400000");
  });

  test("refuses when no exact offer is on the Allowance's network", () => {
    const choice = selectOffer([offer({ network: "near:mainnet" }), offer({ scheme: "upto" })], wanted);
    expect(choice).toMatchObject({ ok: false, refusal: { reason: "NoMatchingOffer" } });
    expect(!choice.ok && choice.refusal.offers).toHaveLength(2);
  });

  test("refuses an offer in another asset", () => {
    const choice = selectOffer([offer({ asset: "fake-usdc.testnet" })], wanted);
    expect(choice).toMatchObject({ ok: false, refusal: { reason: "AssetMismatch" } });
  });

  test("refuses when every usable offer is over the max", () => {
    const choice = selectOffer([offer({ amount: "15000000" })], wanted);
    expect(choice).toMatchObject({ ok: false, refusal: { reason: "OverMaxAmount", message: expect.stringContaining("$15.00") } });
  });

  test("the max is inclusive", () => {
    expect(selectOffer([offer({ amount: "1000000" })], wanted).ok).toBe(true);
  });

  test("a resumed request must match its Payee and amount", () => {
    const request = { payee: "seller.testnet", amount: 500_000n };
    expect(selectOffer([offer()], { ...wanted, request }).ok).toBe(true);
    expect(selectOffer([offer({ payTo: "attacker.testnet" })], { ...wanted, request })).toMatchObject({
      ok: false,
      refusal: { reason: "RequestMismatch" },
    });
    expect(selectOffer([offer({ amount: "600000" })], { ...wanted, request })).toMatchObject({
      ok: false,
      refusal: { reason: "RequestMismatch" },
    });
  });

  test("ignores offers whose amount is not base units", () => {
    expect(selectOffer([offer({ amount: "0.5" })], wanted)).toMatchObject({ ok: false, refusal: { reason: "AssetMismatch" } });
  });
});

describe("dollars", () => {
  test("parses dollars to USDC base units without float rounding", () => {
    expect(usdToBaseUnits("0.50")).toBe(500_000n);
    expect(usdToBaseUnits("$15")).toBe(15_000_000n);
    expect(usdToBaseUnits(0.5)).toBe(500_000n);
    expect(usdToBaseUnits(10)).toBe(10_000_000n);
    expect(usdToBaseUnits(0.1 + 0.2)).toBe(300_000n);
    expect(usdToBaseUnits("0.000001")).toBe(1n);
  });

  test("rejects negative, malformed or over-precise amounts", () => {
    for (const bad of ["-1", "abc", "0.0000001", "", "1e3"]) expect(() => usdToBaseUnits(bad)).toThrow();
    expect(() => usdToBaseUnits(-1)).toThrow();
  });

  test("formats base units as dollars", () => {
    expect(formatUsd(500_000n)).toBe("$0.50");
    expect(formatUsd("15000000")).toBe("$15.00");
    expect(formatUsd(1_250_001n)).toBe("$1.250001");
  });
});
