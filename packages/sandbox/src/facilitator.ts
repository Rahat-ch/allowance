/**
 * The official x402 `exact` facilitator for NEAR, in process, pointed at the
 * sandbox RPC. Same wiring as the tracer (packages/tracer/src/facilitator.ts).
 */
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { NEAR_TESTNET_CAIP2, createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";

export type Facilitator = FacilitatorClient & {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  getSupported(): Promise<SupportedResponse>;
};

export function createFacilitator(config: {
  relayer: { accountId: string; secretKey: `ed25519:${string}` };
  rpcUrl: string;
}): Facilitator {
  const signer = createFacilitatorNearSigner({
    relayers: [config.relayer],
    rpcUrls: { [NEAR_TESTNET_CAIP2]: config.rpcUrl },
  });
  const facilitator = new x402Facilitator().register(NEAR_TESTNET_CAIP2, new ExactNearScheme(signer));
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // x402Facilitator.getSupported() is typed with `network: string` (as of @x402/core 2.30.0).
    getSupported: () => Promise.resolve(facilitator.getSupported() as SupportedResponse),
  };
}
