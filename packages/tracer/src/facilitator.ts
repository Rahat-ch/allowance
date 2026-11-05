/**
 * The official x402 `exact` facilitator for NEAR, run in process.
 *
 * Wiring follows the upstream integration test
 * (x402-foundation/x402 `typescript/packages/mechanisms/near/test/integrations/exact-near.test.ts`):
 * an `x402Facilitator` with the NEAR `ExactNearScheme` registered, adapted to
 * the `FacilitatorClient` interface (whose `getSupported` is async, while
 * `x402Facilitator.getSupported` is sync).
 */
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { createFacilitatorNearSigner, type FacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { NETWORK, readAccountKey } from "./config.js";

export type Facilitator = FacilitatorClient & {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  getSupported(): Promise<SupportedResponse>;
};

/** A facilitator over any NEAR chain view; tests pass a stub, scripts a real relayer. */
export function createFacilitator(signer: FacilitatorNearSigner): Facilitator {
  const facilitator = new x402Facilitator().register(NETWORK, new ExactNearScheme(signer));
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // x402Facilitator.getSupported() is typed with `network: string` while
    // SupportedResponse wants `${string}:${string}` (as of @x402/core 2.30.0);
    // the values are the CAIP-2 networks registered above.
    getSupported: () => Promise.resolve(facilitator.getSupported() as SupportedResponse),
  };
}

/**
 * The real facilitator: the relayer pays gas for settlement with the full-access
 * key in `~/.near-credentials/testnet/<relayerAccountId>.json`.
 */
export function createRelayerFacilitator(relayerAccountId: string, rpcUrl: string): Facilitator {
  const signer = createFacilitatorNearSigner({
    relayers: [{ accountId: relayerAccountId, secretKey: readAccountKey(relayerAccountId) }],
    rpcUrls: { [NETWORK]: rpcUrl },
  });
  return createFacilitator(signer);
}
