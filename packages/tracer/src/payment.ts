/**
 * Turns a Signed Payment from the Allowance contract into what an x402 seller
 * expects: `PaymentRequirements` for the `exact` NEAR scheme, and an x402 v2
 * `PaymentPayload` carrying the contract's `SignedDelegateAction`.
 *
 * The payload is assembled by the official `x402Client` with the official
 * NEAR `exact` client scheme; the only custom part is a signer that hands
 * back the pre-built delegate instead of signing one.
 */
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { decodeSignedDelegateB64, parseFtTransferArgs, type DecodedSignedDelegate } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";
import { NETWORK, USDC_TESTNET } from "./config.js";

const X402_VERSION = 2;
const U128_MAX = (1n << 128n) - 1n;

export type RequirementsInput = {
  /** The Payee account. */
  payTo: string;
  /** Token amount in atomic units (USDC has 6 decimals). */
  amount: bigint | string;
  maxTimeoutSeconds: number;
  /** NEP-141 token contract; defaults to Circle USDC on testnet. */
  asset?: string;
  network?: Network;
};

export function buildPaymentRequirements(input: RequirementsInput): PaymentRequirements {
  if (input.payTo.length === 0) {
    throw new Error("payTo must be a NEAR account id");
  }
  if (!Number.isInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 0) {
    throw new Error(`maxTimeoutSeconds must be a positive integer, got ${input.maxTimeoutSeconds}`);
  }
  return {
    scheme: "exact",
    network: input.network ?? NETWORK,
    asset: input.asset ?? USDC_TESTNET,
    amount: toU128String(input.amount),
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: {},
  };
}

function toU128String(amount: bigint | string): string {
  let value: bigint;
  if (typeof amount === "bigint") {
    value = amount;
  } else if (/^[1-9][0-9]*$/.test(amount)) {
    value = BigInt(amount);
  } else {
    throw new Error(`amount must be a positive decimal integer, got ${JSON.stringify(amount)}`);
  }
  if (value <= 0n || value > U128_MAX) {
    throw new Error(`amount must be in 1..2^128-1, got ${value}`);
  }
  return value.toString();
}

/** Used when the caller has no seller resource to name (e.g. the tracer). */
const TRACER_RESOURCE: ResourceInfo = {
  url: "urn:allowance:tracer",
  description: "Allowance tracer payment",
};

/**
 * Wraps a base64 borsh `SignedDelegateAction` in an x402 v2 `PaymentPayload`
 * for the `exact` NEAR scheme: `{x402Version: 2, accepted, resource, payload:
 * {signedDelegateAction}}`.
 *
 * Fails fast if the delegate is not a single `ft_transfer` of exactly
 * `requirements.amount` on `requirements.asset` to `requirements.payTo`, so a
 * mismatch shows up here rather than as a facilitator reason code. It does not
 * check the signature, nonce or expiry; the facilitator does.
 */
export async function buildPaymentPayload(
  signedDelegateAction: string,
  requirements: PaymentRequirements,
  resource: ResourceInfo = TRACER_RESOURCE,
): Promise<PaymentPayload> {
  assertDelegateMatches(decode(signedDelegateAction), requirements);

  const client = new x402Client()
    // The Allowance contract enforces the Policy; the client-side USD cap
    // (default $1) must not second-guess an amount the contract already signed.
    .setSpendControls(false)
    .register(
      requirements.network,
      new ExactNearScheme({ createSignedDelegateAction: async () => signedDelegateAction }),
    );
  const paymentRequired: PaymentRequired = {
    x402Version: X402_VERSION,
    resource,
    accepts: [requirements],
  };
  return client.createPaymentPayload(paymentRequired);
}

function decode(signedDelegateAction: string): DecodedSignedDelegate {
  if (signedDelegateAction.length === 0) {
    throw new Error("SignedDelegateAction is empty");
  }
  try {
    return decodeSignedDelegateB64(signedDelegateAction);
  } catch (cause) {
    throw new Error("not a base64 borsh SignedDelegateAction", { cause });
  }
}

function assertDelegateMatches({ delegate }: DecodedSignedDelegate, requirements: PaymentRequirements): void {
  const call = delegate.functionCall;
  if (delegate.actionCount !== 1 || call === null || call.methodName !== "ft_transfer") {
    throw new Error("SignedDelegateAction must hold exactly one ft_transfer");
  }
  if (delegate.receiverId !== requirements.asset) {
    throw new Error(`delegate token ${delegate.receiverId} != asset ${requirements.asset}`);
  }
  const transfer = parseFtTransferArgs(call.args);
  if (transfer.receiver_id !== requirements.payTo) {
    throw new Error(`delegate pays ${transfer.receiver_id} != payTo ${requirements.payTo}`);
  }
  if (transfer.amount !== requirements.amount) {
    throw new Error(`delegate amount ${transfer.amount} != amount ${requirements.amount}`);
  }
}
