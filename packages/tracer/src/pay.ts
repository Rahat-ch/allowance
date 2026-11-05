/**
 * `pnpm --filter tracer pay`: one end-to-end Signed Payment on NEAR testnet.
 *
 * The Agent's function-call key asks the Allowance to sign a 0.01 USDC
 * payment to the Payee; the contract funds the Payer Account and gets the
 * delegate signed through Chain Signatures; the official x402 `exact`
 * facilitator then verifies and settles it. Exits non-zero unless the
 * Payee's USDC balance rose by exactly the amount.
 *
 *   --request-id <id>   settle an existing Signed Payment instead of calling
 *                       tracer_sign again (e.g. after the script was interrupted)
 *   --allow-slow-rpc    pay even if FastNEAR is down and the slow fallback RPC
 *                       is in use (settlement may then miss the 60-block window)
 */
import { randomUUID } from "node:crypto";
import {
  getSignedPayment,
  isTerminal,
  tracerSign,
  tracerSignStatus,
  type SignedPayment,
  type TracerSignStatus,
  type TxStatusView,
} from "./allowance.js";
import { accountLink, assertOutsideRepo, isMain, loadEnv, readKeyFile, requireEnv, txLink } from "./config.js";
import { createRelayerFacilitator } from "./facilitator.js";
import { accountWithKey, isFastRpc, isUsdcRegistered, rpc, txStatus, usdcBalance } from "./near.js";
import { buildPaymentPayload, buildPaymentRequirements } from "./payment.js";
import { retry, sleep } from "./retry.js";
import { formatUsdc } from "./usdc.js";

const AMOUNT = 10_000n; // 0.01 USDC
const MAX_TIMEOUT_BLOCKS = 60;
const MAX_TIMEOUT_SECONDS = 60;
/** The MPC yield/resume timeout is about 200 blocks; allow headroom. */
const SIGN_DEADLINE_MS = 5 * 60_000;
/** How long `get_signed_payment` may stay null after `tracer_sign` succeeded (RPC lag). */
const NOT_FOUND_DEADLINE_MS = 30_000;
const POLL_MS = 1_000;
/** Retries for a single RPC read before giving up; about 30 s in all. */
const RPC_RETRY = { attempts: 6, baseDelayMs: 1_000, maxDelayMs: 8_000 } as const;
/** Same rule as the contract's `valid_request_id`. */
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

const USAGE = `usage: pnpm --filter tracer pay [-- [--request-id <id>] [--allow-slow-rpc]]`;

export type PayArgs = { requestId?: string; allowSlowRpc: boolean; help: boolean };

export function parsePayArgs(argv: readonly string[]): PayArgs {
  const args: PayArgs = { allowSlowRpc: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--allow-slow-rpc") {
      args.allowSlowRpc = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--request-id" || arg.startsWith("--request-id=")) {
      const value = arg === "--request-id" ? argv[++i] : arg.slice("--request-id=".length);
      if (value === undefined || value.startsWith("-") || !REQUEST_ID.test(value)) {
        throw new Error(`--request-id needs an id of 16-128 characters of [A-Za-z0-9_-]\n${USAGE}`);
      }
      args.requestId = value;
    } else {
      throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  return args;
}

export type PreflightInput = {
  rpcUrl: string;
  allowSlowRpc: boolean;
  payee: string;
  payeeRegistered: boolean;
  allowanceId: string;
  /** Omitted when resuming: the money has already moved. */
  allowanceBalance?: bigint;
  amount: bigint;
};

/** Everything that would make a new Signed Payment fail or waste funds; empty when it is safe to pay. */
export function preflightProblems(input: PreflightInput): string[] {
  const problems: string[] = [];
  if (!isFastRpc(input.rpcUrl) && !input.allowSlowRpc) {
    problems.push(
      `RPC is ${input.rpcUrl}, not FastNEAR; it is too slow to settle a ${MAX_TIMEOUT_BLOCKS}-block Signed Payment ` +
        `(docs/notes/chain-signatures.md). Retry when FastNEAR answers, or pass --allow-slow-rpc.`,
    );
  }
  if (!input.payeeRegistered) {
    problems.push(
      `Payee ${input.payee} is not registered for USDC storage, so ft_transfer to it would fail; ` +
        `register it with storage_deposit first.`,
    );
  }
  if (input.allowanceBalance !== undefined && input.allowanceBalance < input.amount) {
    problems.push(
      `Allowance ${input.allowanceId} holds ${formatUsdc(input.allowanceBalance)} USDC, needs ${formatUsdc(input.amount)}; ` +
        `run pnpm --filter tracer fund <USDC amount>.`,
    );
  }
  return problems;
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parsePayArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  loadEnv();
  const allowanceId = requireEnv("ALLOWANCE_ACCOUNT_ID");
  const relayerId = requireEnv("RELAYER_ACCOUNT_ID");
  const { url: rpcUrl } = await rpc();
  console.log(`RPC ${rpcUrl}`);

  let requestId = args.requestId;
  let payee: string;
  let amount: bigint;
  if (requestId !== undefined) {
    const existing = await retryRead(() => getSignedPayment(allowanceId, requestId!), "get_signed_payment");
    if (existing === null) throw new Error(`no Signed Payment with request_id ${requestId} on ${allowanceId}`);
    payee = existing.payee;
    amount = BigInt(existing.amount);
    console.log(`Resuming ${requestId}: ${existing.status}, ${formatUsdc(amount)} USDC to ${payee}`);
  } else {
    payee = requireEnv("PAYEE_ACCOUNT_ID");
    amount = AMOUNT;
  }

  const problems = preflightProblems({
    rpcUrl,
    allowSlowRpc: args.allowSlowRpc,
    payee,
    payeeRegistered: await isUsdcRegistered(payee),
    allowanceId,
    allowanceBalance: requestId === undefined ? await usdcBalance(allowanceId) : undefined,
    amount,
  });
  if (problems.length > 0) {
    throw new Error(`pre-flight failed, nothing was signed:\n  - ${problems.join("\n  - ")}`);
  }

  const facilitator = createRelayerFacilitator(relayerId, rpcUrl);
  let signTx: { txHash: string; status: TracerSignStatus } | undefined;
  if (requestId === undefined) {
    const agentKeyFile = requireEnv("AGENT_KEY_FILE");
    assertOutsideRepo(agentKeyFile, "AGENT_KEY_FILE");
    const agent = await accountWithKey(allowanceId, readKeyFile(agentKeyFile));
    requestId = `tracer-${randomUUID()}`;
    console.log(`tracer_sign request_id=${requestId} amount=${amount} max_timeout_blocks=${MAX_TIMEOUT_BLOCKS}`);
    signTx = await tracerSign(agent, {
      request_id: requestId,
      payee,
      amount: amount.toString(),
      max_timeout_blocks: MAX_TIMEOUT_BLOCKS,
    }).catch((error: unknown) => {
      throw new Error(`tracer_sign failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    console.log(`  tx ${signTx.txHash}\n  ${txLink(signTx.txHash)}`);
  }

  try {
    await settle({ allowanceId, requestId, signTx, payee, amount, facilitator });
  } catch (error) {
    if (signTx === undefined || !(error instanceof Error) || error.message.startsWith("tracer_sign failed")) throw error;
    throw new Error(`${error.message}\nTo retry settling it: pnpm --filter tracer pay -- --request-id ${requestId}`);
  }
}

async function settle(input: {
  allowanceId: string;
  requestId: string;
  signTx: { txHash: string; status: TracerSignStatus } | undefined;
  payee: string;
  amount: bigint;
  facilitator: ReturnType<typeof createRelayerFacilitator>;
}): Promise<void> {
  const { allowanceId, requestId, signTx, payee, amount, facilitator } = input;
  const payment = await waitForSignature(allowanceId, requestId, signTx);
  console.log(
    `Signed: key ${payment.public_key} nonce ${payment.nonce} max_block_height ${payment.max_block_height}`,
  );

  const requirements = buildPaymentRequirements({
    payTo: payee,
    amount,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  });
  const payload = await buildPaymentPayload(payment.signed_delegate_action!, requirements);

  const before = await usdcBalance(payee);
  console.log(`Payee ${payee} USDC before: ${formatUsdc(before)}`);

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
  if (delta !== amount) {
    throw new Error(`Payee balance rose by ${delta}, expected exactly ${amount}`);
  }
  console.log("OK: the unmodified x402 exact facilitator verified and settled the Signed Payment.");
}

function retryRead<T>(fn: () => Promise<T>, what: string): Promise<T> {
  return retry(fn, {
    ...RPC_RETRY,
    onRetry: (error, attempt, delayMs) =>
      console.warn(
        `  ${what} failed (${error instanceof Error ? error.message : String(error)}); retry ${attempt} in ${delayMs} ms`,
      ),
  });
}

/**
 * Polls `get_signed_payment` until the Signed Payment is terminal. While the
 * `tracer_sign` receipt has not run yet, also polls the transaction so a
 * panic (e.g. "request id already used") is reported at once.
 */
async function waitForSignature(
  allowanceId: string,
  requestId: string,
  signTx: { txHash: string; status: TracerSignStatus } | undefined,
): Promise<SignedPayment> {
  const started = Date.now();
  const where = signTx ? txLink(signTx.txHash) : `get_signed_payment ${requestId}`;
  let accepted = signTx === undefined || signTx.status.kind === "accepted";
  let acceptedAt = started;
  if (signTx?.status.kind === "failed") throw new Error(`tracer_sign failed: ${signTx.status.message}`);
  let last: string | undefined;
  for (;;) {
    if (!accepted && signTx) {
      const view = await retryRead(() => txStatus(signTx.txHash, allowanceId), "tx status");
      const status = tracerSignStatus(view as TxStatusView);
      if (status.kind === "failed") throw new Error(`tracer_sign failed: ${status.message}`);
      if (status.kind === "accepted") {
        accepted = true;
        acceptedAt = Date.now();
      }
    }
    const payment = await retryRead(() => getSignedPayment(allowanceId, requestId), "get_signed_payment");
    const elapsed = Date.now() - started;
    if (payment === null) {
      if (accepted && Date.now() - acceptedAt > NOT_FOUND_DEADLINE_MS) {
        throw new Error(`no Signed Payment for ${requestId} after ${elapsed} ms; check ${where}`);
      }
    } else {
      if (payment.status !== last) {
        console.log(`  status ${payment.status} (+${(elapsed / 1000).toFixed(1)}s)`);
        last = payment.status;
      }
      if (isTerminal(payment.status)) {
        if (payment.status !== "Signed" || !payment.signed_delegate_action) {
          throw new Error(`Signed Payment ended as ${payment.status}; check ${where}`);
        }
        return payment;
      }
    }
    if (elapsed > SIGN_DEADLINE_MS) {
      throw new Error(`still ${last ?? "missing"} after ${elapsed} ms; check ${where}`);
    }
    await sleep(POLL_MS);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
