/**
 * The Owner's sweep: gets USDC that uncollected Signed Payments left in the Payer Account
 * back into the Allowance.
 *
 * 1. The Owner calls `sweep` on the Allowance (1 yoctoNEAR, so a wallet or full-access key
 *    confirms it). The contract leases a Payer Account key whose Signed Payment has
 *    expired, reads the Payer Account's USDC balance, caps the amount, and has a NEP-366
 *    delegate `ft_transfer_call(Allowance, amount, "sweep:<id>")` signed through Chain
 *    Signatures.
 * 2. This script polls `get_sweep` until it is Signed (or Refused).
 * 3. It relays the signed delegate: a transaction from the relayer to the Payer Account
 *    with a single Delegate action. Anyone can relay; the relayer only pays gas.
 * 4. The USDC arrives through `ft_on_transfer` and the sweep is Settled; it is Withdrawable.
 *
 * `pnpm --filter deploy run sweep [-- <USDC amount>]` runs it with OWNER_ACCOUNT_ID,
 * ALLOWANCE_ACCOUNT_ID, NEAR_NETWORK (testnet or mainnet, default testnet) and optionally
 * RELAYER_ACCOUNT_ID (default: the Owner) from the repo's `.env`. Keys come from
 * `~/.near-credentials/<network>` (near-cli's format). Without an amount it sweeps
 * everything sweepable. The sandbox tests call `sweepAndRelay` directly.
 */
import { join } from "node:path";
import { deserialize } from "borsh";
import { config as loadDotenv } from "dotenv";
import { Account, SCHEMA, type SerializedReturnValue, type SignedDelegate, actions } from "near-api-js";
import { connect } from "./chain.js";
import { NETWORKS } from "./config.js";
import { defaultCredentialsDir, readKeyFile } from "./keys.js";
import { ENV_FILE, isMain } from "./main.js";
import { TGAS, formatUsdc, parseUsdc } from "./units.js";

/** `sweep` itself, the balance read and the signing callbacks (~115 TGas). */
export const SWEEP_GAS = 150n * TGAS;
const POLL_MS = 1_000;
/** The MPC yield/resume timeout is about 200 blocks; allow headroom. */
const SIGN_DEADLINE_MS = 5 * 60_000;

export type SweepStatus =
  | "Checking"
  | "Signing"
  | "Signed"
  | "Settled"
  | "Refused"
  | "SignatureUnavailable"
  | "Expired";

/** `get_sweep` result. */
export type Sweep = {
  id: number;
  status: SweepStatus;
  requested_amount: string | null;
  amount: string;
  payer_balance: string | null;
  outstanding: string | null;
  refused_reason: string | null;
  key_index: number;
  public_key: string;
  nonce: number | null;
  max_block_height: number | null;
  /** Base64 borsh `SignedDelegateAction`, once Signed. */
  signed_delegate_action: string | null;
  requested_at_ns: number;
  requested_at_height: number;
};

export type SweepOptions = {
  /** USDC base units; omit to sweep everything sweepable. */
  amount?: bigint;
  pollMs?: number;
  signDeadlineMs?: number;
};

export type SweepResult = { sweep: Sweep; relayTxHash: string };

export async function getSweep(viewer: Account, allowanceId: string, id: number): Promise<Sweep | null> {
  return (await viewer.provider.callFunction<SerializedReturnValue>({
    contractId: allowanceId,
    method: "get_sweep",
    args: { id },
  })) as Sweep | null;
}

/** Asks the Allowance for a sweep as the Owner; resolves to its id. Rejects with the contract's message (e.g. "busy: ..."). */
export async function requestSweep(owner: Account, allowanceId: string, amount?: bigint): Promise<number> {
  return (await owner.callFunction({
    contractId: allowanceId,
    methodName: "sweep",
    args: { amount: amount === undefined ? null : amount.toString() },
    deposit: 1n,
    gas: SWEEP_GAS,
  })) as number;
}

/** Polls `get_sweep` until it leaves Checking and Signing. */
export async function waitForSweep(
  viewer: Account,
  allowanceId: string,
  id: number,
  { pollMs = POLL_MS, signDeadlineMs = SIGN_DEADLINE_MS }: SweepOptions = {},
): Promise<Sweep> {
  const deadline = Date.now() + signDeadlineMs;
  for (;;) {
    const sweep = await getSweep(viewer, allowanceId, id);
    if (sweep && sweep.status !== "Checking" && sweep.status !== "Signing") return sweep;
    if (Date.now() > deadline) throw new Error(`sweep ${id} is still ${sweep?.status ?? "unknown"} after ${signDeadlineMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Decodes a base64 borsh `SignedDelegateAction` with the NEAR JS schema. */
export function decodeSignedDelegate(base64: string): SignedDelegate {
  return deserialize(SCHEMA.SignedDelegate, Buffer.from(base64, "base64")) as SignedDelegate;
}

/**
 * Relays a signed delegate: a transaction from `relayer` to the delegate's sender (the
 * Payer Account) with one Delegate action. Rejects if the transaction fails.
 */
export async function relaySignedDelegate(relayer: Account, base64: string): Promise<string> {
  const signedDelegate = decodeSignedDelegate(base64);
  const outcome = await relayer.signAndSendTransaction({
    receiverId: signedDelegate.delegateAction.senderId,
    actions: [actions.signedDelegate(signedDelegate)],
    waitUntil: "FINAL",
  });
  return outcome.transaction_outcome.id;
}

/**
 * The whole sweep: request it as `owner`, wait until signed, relay it with `relayer`, and
 * wait until the Allowance has credited it (Settled). Rejects if the sweep is refused,
 * its signature never arrives, or it doesn't settle.
 */
export async function sweepAndRelay(
  owner: Account,
  relayer: Account,
  allowanceId: string,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const id = await requestSweep(owner, allowanceId, options.amount);
  const signed = await waitForSweep(owner, allowanceId, id, options);
  if (signed.status !== "Signed" || signed.signed_delegate_action === null) {
    throw new Error(`sweep ${id} ended ${signed.status}${signed.refused_reason ? `: ${signed.refused_reason}` : ""}`);
  }
  const relayTxHash = await relaySignedDelegate(relayer, signed.signed_delegate_action);
  const sweep = await getSweep(owner, allowanceId, id);
  if (sweep?.status !== "Settled") throw new Error(`sweep ${id} relayed in ${relayTxHash} but is ${sweep?.status}`);
  return { sweep, relayTxHash };
}

const USAGE = "usage: pnpm --filter deploy run sweep [-- <USDC amount>]";

/** The optional USDC amount after pnpm's `--`. */
export function parseSweepArgs(argv: readonly string[]): { amount?: bigint; help: boolean } {
  const rest = argv.filter((a) => a !== "--");
  if (rest.some((a) => a === "--help" || a === "-h")) return { help: true };
  if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) throw new Error(USAGE);
  if (rest.length === 0) return { help: false };
  const amount = parseUsdc(rest[0]!);
  if (amount === 0n) throw new Error("amount must be positive");
  return { amount, help: false };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseSweepArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  loadDotenv({ path: ENV_FILE, quiet: true });
  const env = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set; add it to ${ENV_FILE}`);
    return value;
  };
  const networkName = process.env.NEAR_NETWORK?.trim() || "testnet";
  if (networkName !== "testnet" && networkName !== "mainnet") throw new Error(`NEAR_NETWORK must be testnet or mainnet, not ${networkName}`);
  const network = NETWORKS[networkName];
  const ownerId = env("OWNER_ACCOUNT_ID");
  const allowanceId = env("ALLOWANCE_ACCOUNT_ID");
  const relayerId = process.env.RELAYER_ACCOUNT_ID?.trim() || ownerId;

  const chain = await connect(network.rpcUrls);
  const credentials = defaultCredentialsDir(network.name);
  const accountFor = (id: string) => new Account(id, chain.provider, readKeyFile(join(credentials, `${id}.json`)));
  const owner = accountFor(ownerId);
  const relayer = relayerId === ownerId ? owner : accountFor(relayerId);

  const { sweep, relayTxHash } = await sweepAndRelay(owner, relayer, allowanceId, { amount: args.amount });
  console.log(`sweep ${sweep.id}: ${formatUsdc(BigInt(sweep.amount))} USDC back to ${allowanceId}`);
  console.log(
    `  Payer Account held ${formatUsdc(BigInt(sweep.payer_balance ?? "0"))}, unexpired payments ${formatUsdc(BigInt(sweep.outstanding ?? "0"))}`,
  );
  console.log(`  relayed by ${relayerId}: ${network.explorerUrl ? `${network.explorerUrl}/txns/${relayTxHash}` : relayTxHash}`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
