/**
 * The seller's 402 offers and configuration, without a chain: a stub
 * facilitator only answers `getSupported`. Paid calls and replay run against
 * the sandbox in packages/sandbox/test/demo-seller.test.ts.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { getDefaultAsset } from "@x402/near";
import { dollarsToBaseUnits, resolveConfig, sellerOptionsFromEnv, startSeller, type Seller, type SellerOptions } from "../src/index.js";

const stubFacilitator: FacilitatorClient = {
  verify: async () => ({ isValid: false, invalidReason: "stub" }),
  settle: async () => {
    throw new Error("stub facilitator does not settle");
  },
  getSupported: async () => ({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "near:testnet" },
      { x402Version: 2, scheme: "exact", network: "near:mainnet" },
    ],
    extensions: [],
    signers: {},
  }),
};

const running: Seller[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function start(options: Omit<SellerOptions, "facilitator">): Promise<Seller> {
  const seller = await startSeller({ facilitator: stubFacilitator, ...options });
  running.push(seller);
  return seller;
}

async function offerFor(url: string) {
  const response = await fetch(url);
  expect(response.status).toBe(402);
  const header = response.headers.get("payment-required");
  expect(header).toBeTruthy();
  const required = JSON.parse(Buffer.from(header!, "base64").toString());
  expect(required.x402Version).toBe(2);
  expect(required.accepts).toHaveLength(1);
  return { required, offer: required.accepts[0] };
}

describe("unpaid calls", () => {
  test("GET /weather offers exact Circle USDC on NEAR testnet for $0.50 by default", async () => {
    const seller = await start({ payTo: "payee.testnet" });
    const { required, offer } = await offerFor(`${seller.url}/weather`);
    expect(offer).toEqual({
      scheme: "exact",
      network: "near:testnet",
      asset: getDefaultAsset("near:testnet").asset,
      amount: "500000",
      payTo: "payee.testnet",
      maxTimeoutSeconds: 60,
      extra: {},
    });
    expect(required.resource).toMatchObject({ url: expect.stringContaining("/weather") });
  });

  test("GET /report is the $15 premium report", async () => {
    const seller = await start({ payTo: "payee.testnet" });
    const { offer } = await offerFor(`${seller.url}/report`);
    expect(offer).toMatchObject({ scheme: "exact", amount: "15000000", payTo: "payee.testnet" });
  });

  test("the index is free and lists the prices", async () => {
    const seller = await start({ payTo: "payee.testnet" });
    const response = await fetch(`${seller.url}/`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      payTo: "payee.testnet",
      routes: { "GET /weather": "$0.50", "GET /report": "$15.00" },
    });
  });
});

describe("configuration", () => {
  test("network, payTo, asset, prices and timeout are honoured", async () => {
    const seller = await start({
      network: "near:mainnet",
      payTo: "shop.near",
      asset: "usdc.example.near",
      prices: { weather: "$0.01", report: "$2.5" },
      maxTimeoutSeconds: 120,
    });
    const weather = (await offerFor(`${seller.url}/weather`)).offer;
    expect(weather).toMatchObject({
      network: "near:mainnet",
      payTo: "shop.near",
      asset: "usdc.example.near",
      amount: "10000",
      maxTimeoutSeconds: 120,
    });
    expect((await offerFor(`${seller.url}/report`)).offer).toMatchObject({ amount: "2500000", network: "near:mainnet" });
  });

  test("mainnet defaults to mainnet Circle USDC", () => {
    expect(resolveConfig({ facilitator: stubFacilitator, payTo: "shop.near", network: "near:mainnet" }).asset).toBe(
      getDefaultAsset("near:mainnet").asset,
    );
  });

  test("bad configuration is refused up front", () => {
    const base = { facilitator: stubFacilitator, payTo: "p.testnet" };
    expect(() => resolveConfig({ ...base, payTo: "" })).toThrow(/payTo/);
    expect(() => resolveConfig({ ...base, network: "eip155:1" as never })).toThrow(/network/);
    expect(() => resolveConfig({ ...base, prices: { weather: "$0.0000001" } })).toThrow(/6 decimals/);
    expect(() => resolveConfig({ ...base, maxTimeoutSeconds: 0 })).toThrow(/maxTimeoutSeconds/);
  });

  test("from the environment, with an HTTP facilitator", () => {
    const options = sellerOptionsFromEnv({
      FACILITATOR_URL: "https://facilitator.example",
      SELLER_PAY_TO: "shop.near",
      SELLER_NETWORK: "near:mainnet",
      SELLER_ASSET: "usdc.example.near",
      SELLER_WEATHER_PRICE: "0.25",
      SELLER_REPORT_PRICE: "$9",
      SELLER_MAX_TIMEOUT_SECONDS: "90",
      PORT: "8080",
    });
    expect(options.facilitator).toBeInstanceOf(HTTPFacilitatorClient);
    expect(options).toMatchObject({
      facilitatorUrl: "https://facilitator.example",
      payTo: "shop.near",
      network: "near:mainnet",
      asset: "usdc.example.near",
      prices: { weather: "$0.25", report: "$9" },
      maxTimeoutSeconds: 90,
      port: 8080,
    });
    expect(resolveConfig(sellerOptionsFromEnv({ FACILITATOR_URL: "http://f", SELLER_PAY_TO: "p.testnet" }))).toMatchObject({
      network: "near:testnet",
      prices: { weather: "$0.50", report: "$15.00" },
      maxTimeoutSeconds: 60,
    });
    expect(() => sellerOptionsFromEnv({ SELLER_PAY_TO: "p.testnet" })).toThrow(/FACILITATOR_URL/);
    expect(() => sellerOptionsFromEnv({ FACILITATOR_URL: "http://f" })).toThrow(/SELLER_PAY_TO/);
  });
});

test("dollarsToBaseUnits converts without float rounding", () => {
  expect(dollarsToBaseUnits("0.5")).toBe("500000");
  expect(dollarsToBaseUnits("15")).toBe("15000000");
  expect(dollarsToBaseUnits("0.000001")).toBe("1");
  expect(() => dollarsToBaseUnits("1e-7")).toThrow();
});
