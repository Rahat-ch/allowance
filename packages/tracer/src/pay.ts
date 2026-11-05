/**
 * `pnpm --filter tracer pay`: one end-to-end Signed Payment on NEAR testnet.
 *
 * The Agent's function-call key asks the Allowance to sign a 0.01 USDC
 * payment to the Payee; the contract funds the Payer Account and gets the
 * delegate signed through Chain Signatures; the official x402 `exact`
 * facilitator then verifies and settles it. Exits non-zero unless the
 * Payee's USDC balance rose by exactly the amount.
 */
import { randomUUID } from "node:crypto";
import { getSignedPayment, isTerminal, tracerSign, type SignedPayment } from "./allowance.js";
import { accountLink, loadEnv, readKeyFile, requireEnv, txLink } from "./config.js";
import { createRelayerFacilitator } from "./facilitator.js";
import { accountWithKey, rpcUrl, usdcBalance } from "./near.js";
import { formatUsdc } from "./usdc.js";
import { buildPaymentPayload, buildPaymentRequirements } from "./payment.js";

const AMOUNT = 10_000n; // 0.01 USDC
const MAX_TIMEOUT_BLOCKS = 60;
const MAX_TIMEOUT_SECONDS = 60;
/** The MPC yield/resume timeout is about 200 blocks; allow headroom. */
const SIGN_DEADLINE_MS = 5 * 60_000;
/** How long `get_signed_payment` may stay null after `tracer_sign` lands. */
const NOT_FOUND_DEADLINE_MS = 30_000;
const POLL_MS = 1_000;

async function main(): Promise<void> {
  loadEnv();
  const allowanceId = requireEnv("ALLOWANCE_ACCOUNT_ID");
  const relayerId = requireEnv("RELAYER_ACCOUNT_ID");
  const payee = requireEnv("PAYEE_ACCOUNT_ID");
  const agent = accountWithKey(allowanceId, readKeyFile(requireEnv("AGENT_KEY_FILE")));
  const facilitator = createRelayerFacilitator(relayerId, rpcUrl);

  const before = await usdcBalance(payee);
  console.log(`Payee ${payee} USDC before: ${formatUsdc(before)}`);

  const requestId = `tracer-${randomUUID()}`;
  console.log(`tracer_sign request_id=${requestId} amount=${AMOUNT} max_timeout_blocks=${MAX_TIMEOUT_BLOCKS}`);
  const signTx = await tracerSign(agent, {
    request_id: requestId,
    payee,
    amount: AMOUNT.toString(),
    max_timeout_blocks: MAX_TIMEOUT_BLOCKS,
  });
  console.log(`  tx ${signTx}\n  ${txLink(signTx)}`);

  const payment = await waitForSignature(allowanceId, requestId, signTx);
  console.log(
    `Signed: key ${payment.public_key} nonce ${payment.nonce} max_block_height ${payment.max_block_height}`,
  );

  const requirements = buildPaymentRequirements({
    payTo: payee,
    amount: AMOUNT,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  });
  const payload = await buildPaymentPayload(payment.signed_delegate_action!, requirements);

  const verified = await facilitator.verify(payload, requirements);
  console.log(`verify: ${JSON.stringify(verified)}`);
  if (!verified.isValid) {
    throw new Error(`facilitator rejected the payment: ${verified.invalidReason} ${verified.invalidMessage ?? ""}`);
  }

  const settled = await facilitator.settle(payload, requirements);
  console.log(`settle: ${JSON.stringify(settled)}`);
  if (settled.transaction) {
    console.log(`  settlement tx ${settled.transaction}\n  ${txLink(settled.transaction)}`);
  }
  if (!settled.success) {
    throw new Error(`settlement failed: ${settled.errorReason} ${settled.errorMessage ?? ""}`);
  }

  const after = await usdcBalance(payee);
  const delta = after - before;
  console.log(`Payee USDC after: ${formatUsdc(after)} (delta ${formatUsdc(delta)})`);
  console.log(`  payer ${verified.payer}: ${accountLink(verified.payer ?? "")}`);
  console.log(`  payee: ${accountLink(payee)}`);
  if (delta !== AMOUNT) {
    throw new Error(`Payee balance rose by ${delta}, expected exactly ${AMOUNT}`);
  }
  console.log("OK: the unmodified x402 exact facilitator verified and settled the Signed Payment.");
}

async function waitForSignature(allowanceId: string, requestId: string, signTx: string): Promise<SignedPayment> {
  const started = Date.now();
  let last: string | undefined;
  for (;;) {
    const payment = await getSignedPayment(allowanceId, requestId);
    const elapsed = Date.now() - started;
    if (payment === null) {
      if (elapsed > NOT_FOUND_DEADLINE_MS) {
        throw new Error(`no Signed Payment for ${requestId} after ${elapsed} ms; check ${txLink(signTx)}`);
      }
    } else {
      if (payment.status !== last) {
        console.log(`  status ${payment.status} (+${(elapsed / 1000).toFixed(1)}s)`);
        last = payment.status;
      }
      if (isTerminal(payment.status)) {
        if (payment.status !== "Signed" || !payment.signed_delegate_action) {
          throw new Error(`Signed Payment ended as ${payment.status}; check ${txLink(signTx)}`);
        }
        return payment;
      }
    }
    if (elapsed > SIGN_DEADLINE_MS) {
      throw new Error(`still ${last ?? "missing"} after ${elapsed} ms; check ${txLink(signTx)}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
