import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  encodeSignedDelegate,
  type KeyPairString,
} from "near-api-js";
import type { FacilitatorNearSigner } from "@x402/near";
import { createFacilitator } from "../src/facilitator.js";
import { buildPaymentPayload, buildPaymentRequirements } from "../src/payment.js";

const USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const USDC_MAINNET = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

type GoldenCase = {
  name: string;
  input: { sender_id: string; token_id: string; payee: string; amount: string };
  expected: { signed_delegate_action_base64: string };
};

const golden = JSON.parse(
  readFileSync(new URL("../../golden-vectors/fixtures/delegate-vectors.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

function goldenCase(name: string): GoldenCase {
  const found = golden.cases.find(c => c.name === name);
  if (!found) throw new Error(`no golden case ${name}`);
  return found;
}

/** Built by the official NEAR JS encoder: USDC testnet, 1 USDC to merchant.testnet. */
const usdcCase = goldenCase("testnet_usdc_one_dollar_30_tgas");

describe("buildPaymentRequirements", () => {
  it("builds exact-scheme requirements for Circle USDC on NEAR testnet", () => {
    expect(
      buildPaymentRequirements({ payTo: "merchant.testnet", amount: 10_000n, maxTimeoutSeconds: 60 }),
    ).toEqual({
      scheme: "exact",
      network: "near:testnet",
      asset: USDC_TESTNET,
      amount: "10000",
      payTo: "merchant.testnet",
      maxTimeoutSeconds: 60,
      extra: {},
    });
  });

  it("accepts the amount as a decimal string and keeps u128 precision", () => {
    const max = "340282366920938463463374607431768211455";
    expect(
      buildPaymentRequirements({ payTo: "merchant.testnet", amount: max, maxTimeoutSeconds: 60 }).amount,
    ).toBe(max);
  });

  it("defaults the asset to the network's USDC", () => {
    expect(
      buildPaymentRequirements({
        payTo: "merchant.near",
        amount: 1n,
        maxTimeoutSeconds: 60,
        network: "near:mainnet",
      }).asset,
    ).toBe(USDC_MAINNET);
  });

  it("uses an explicit asset when given", () => {
    expect(
      buildPaymentRequirements({
        payTo: "merchant.testnet",
        amount: 1n,
        maxTimeoutSeconds: 60,
        asset: "usdc.fakes.testnet",
      }).asset,
    ).toBe("usdc.fakes.testnet");
  });

  it.each([
    ["zero", "0"],
    ["negative", -5n],
    ["non-integer string", "1.5"],
    ["non-decimal string", "0x10"],
    ["empty string", ""],
    ["leading zero", "010"],
    ["above u128", (1n << 128n).toString()],
  ])("rejects a %s amount", (_label, amount) => {
    expect(() =>
      buildPaymentRequirements({ payTo: "merchant.testnet", amount, maxTimeoutSeconds: 60 }),
    ).toThrow(/amount/);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects maxTimeoutSeconds %s", maxTimeoutSeconds => {
    expect(() =>
      buildPaymentRequirements({ payTo: "merchant.testnet", amount: 1n, maxTimeoutSeconds }),
    ).toThrow(/maxTimeoutSeconds/);
  });

  it("rejects an empty payTo", () => {
    expect(() => buildPaymentRequirements({ payTo: "", amount: 1n, maxTimeoutSeconds: 60 })).toThrow(
      /payTo/,
    );
  });
});

describe("buildPaymentPayload", () => {
  const requirements = buildPaymentRequirements({
    payTo: usdcCase.input.payee,
    amount: usdcCase.input.amount,
    maxTimeoutSeconds: 60,
  });

  it("wraps the signed delegate in an x402 v2 exact NEAR payload", async () => {
    const payload = await buildPaymentPayload(
      usdcCase.expected.signed_delegate_action_base64,
      requirements,
    );

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirements);
    expect(payload.payload).toEqual({
      signedDelegateAction: usdcCase.expected.signed_delegate_action_base64,
    });
  });

  it("carries the resource it is given", async () => {
    const resource = { url: "https://seller.example/api", description: "paid API" };
    const payload = await buildPaymentPayload(
      usdcCase.expected.signed_delegate_action_base64,
      requirements,
      resource,
    );
    expect(payload.resource).toEqual(resource);
  });

  it("rejects a delegate paying a different Payee", async () => {
    await expect(
      buildPaymentPayload(usdcCase.expected.signed_delegate_action_base64, {
        ...requirements,
        payTo: "someone-else.testnet",
      }),
    ).rejects.toThrow(/payTo/);
  });

  it("rejects a delegate for a different amount", async () => {
    await expect(
      buildPaymentPayload(usdcCase.expected.signed_delegate_action_base64, {
        ...requirements,
        amount: "999999",
      }),
    ).rejects.toThrow(/amount/);
  });

  it("rejects a delegate on a different token contract", async () => {
    const other = goldenCase("minimal_amount_short_ids");
    await expect(
      buildPaymentPayload(
        other.expected.signed_delegate_action_base64,
        buildPaymentRequirements({ payTo: other.input.payee, amount: other.input.amount, maxTimeoutSeconds: 60 }),
      ),
    ).rejects.toThrow(/asset/);
  });

  it("rejects bytes that are not a SignedDelegateAction", async () => {
    await expect(buildPaymentPayload("bm90IGEgZGVsZWdhdGU=", requirements)).rejects.toThrow(
      /SignedDelegateAction/,
    );
  });

  it("rejects an empty string", async () => {
    await expect(buildPaymentPayload("", requirements)).rejects.toThrow(/SignedDelegateAction/);
  });
});

describe("buildPaymentPayload with the official facilitator", () => {
  const payer = "pay.allowance.testnet";
  const payee = "merchant.testnet";
  const relayer = "relayer.testnet";
  const height = 200_000_000n;

  async function signedDelegate(secretKey: KeyPairString, amount = "10000"): Promise<string> {
    const signer = KeyPairSigner.fromSecretKey(secretKey);
    const delegate = buildDelegateAction({
      senderId: payer,
      receiverId: USDC_TESTNET,
      actions: [
        actions.functionCall("ft_transfer", { receiver_id: payee, amount }, 30_000_000_000_000n, 1n),
      ],
      nonce: height * 1_000_000n - 5n,
      maxBlockHeight: height + 50n,
      publicKey: await signer.getPublicKey(),
    });
    const { signedDelegate } = await signer.signDelegateAction(delegate);
    return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  }

  /** Chain state for a funded Payer Account whose key is full-access. */
  function chain(submitted: string[]): FacilitatorNearSigner {
    return {
      getRelayerIds: () => [relayer],
      getCurrentBlockHeight: async () => height,
      viewAccount: async ({ accountId }) => ({
        codeHash: accountId === USDC_TESTNET ? "ByteCodeHashOfTheToken1111111111" : "11111111111111111111111111111111",
      }),
      viewAccessKey: async () => ({ nonce: 1n, permissionKind: "FullAccess" }),
      ftBalanceOf: async () => 100_000_000n,
      storageBalanceOf: async () => ({ supported: true, registered: true }),
      submitSignedDelegateAction: async ({ signedDelegateAction }) => {
        submitted.push(signedDelegateAction);
        return { transaction: "TXHASH", innerReceipt: { kind: "success", value: "" } };
      },
    };
  }

  it("produces a payload the facilitator verifies and settles", async () => {
    const b64 = await signedDelegate(KeyPair.fromRandom("ed25519").toString() as KeyPairString);
    const requirements = buildPaymentRequirements({ payTo: payee, amount: 10_000n, maxTimeoutSeconds: 60 });
    const payload = await buildPaymentPayload(b64, requirements);
    const submitted: string[] = [];
    const facilitator = createFacilitator(chain(submitted));

    const verified = await facilitator.verify(payload, requirements);
    expect(verified).toEqual({ isValid: true, payer });

    const settled = await facilitator.settle(payload, requirements);
    expect(settled).toMatchObject({ success: true, transaction: "TXHASH", network: "near:testnet", payer });
    expect(submitted).toEqual([b64]);
  });

  it("builds and verifies a payment above the client's default $1 spend cap", async () => {
    // 5 USDC. The x402 client refuses this by default; the Allowance contract
    // enforces the Policy, so buildPaymentPayload must not.
    const amount = "5000000";
    const b64 = await signedDelegate(KeyPair.fromRandom("ed25519").toString() as KeyPairString, amount);
    const requirements = buildPaymentRequirements({ payTo: payee, amount, maxTimeoutSeconds: 60 });
    const payload = await buildPaymentPayload(b64, requirements);
    expect(payload.accepted.amount).toBe(amount);

    const verified = await createFacilitator(chain([])).verify(payload, requirements);
    expect(verified).toEqual({ isValid: true, payer });
  });

  it("advertises the exact scheme on near:testnet", async () => {
    const facilitator = createFacilitator(chain([]));
    const supported = await facilitator.getSupported();
    expect(supported.kinds).toContainEqual(
      expect.objectContaining({ x402Version: 2, scheme: "exact", network: "near:testnet" }),
    );
  });
});
