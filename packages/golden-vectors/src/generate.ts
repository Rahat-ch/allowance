/**
 * Golden vectors for the Allowance contract's NEP-366 delegate encoding.
 *
 * Every expected value here comes from the official NEAR JS encoder
 * (`@near-js/transactions`), built the same way the x402 NEAR `exact` client
 * builds a payment (`actionCreators.functionCall` + `buildDelegateAction` +
 * `encodeDelegateAction` / `encodeSignedDelegate`). The Rust tests in
 * `contracts/allowance/tests` compare their bytes to this fixture, so the
 * fixture must never be produced by the Rust code itself.
 *
 * Two fixtures: `delegate-vectors.json` (Signed Payments: one `ft_transfer`) and
 * `ft-transfer-call-vectors.json` (sweeps: one `ft_transfer_call` back to the
 * Allowance).
 *
 * Run `pnpm --filter golden-vectors generate` to rewrite the fixtures; commit them.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KeyType, PublicKey } from "@near-js/crypto";
import {
  Signature,
  SignedDelegate,
  actionCreators,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
} from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha256";

type CaseInput = {
  name: string;
  senderId: string;
  tokenId: string;
  payee: string;
  amount: bigint;
  nonce: bigint;
  maxBlockHeight: bigint;
  gas: bigint;
  /** 32-byte ed25519 public key, hex. */
  publicKeyHex: string;
};

const ONE_YOCTO = 1n;
const TGAS = 1_000_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/** Fixed, recognisable 32-byte keys. These are test bytes, not real keys. */
const KEY_A = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
const KEY_B = "ff".repeat(32);
const KEY_C = "a1b2c3d4e5f60718293a4b5c6d7e8f90".repeat(2);

/**
 * Fixed 64-byte test signature (bytes 0x40..0x7f). It does not verify; it only
 * pins the SignedDelegateAction layout.
 */
const TEST_SIGNATURE_HEX = Array.from({ length: 64 }, (_, i) => (0x40 + i).toString(16).padStart(2, "0")).join("");

const CASES: CaseInput[] = [
  {
    name: "testnet_usdc_one_dollar_30_tgas",
    senderId: "payer.allowance.testnet",
    tokenId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    payee: "payee.testnet",
    amount: 1_000_000n,
    nonce: 1n,
    maxBlockHeight: 200_000_060n,
    gas: 30n * TGAS,
    publicKeyHex: KEY_A,
  },
  {
    name: "minimal_amount_short_ids",
    senderId: "a.near",
    tokenId: "usdc.near",
    payee: "b.near",
    amount: 1n,
    nonce: 42n,
    maxBlockHeight: 1n,
    gas: 1n * TGAS,
    publicKeyHex: KEY_B,
  },
  {
    name: "u128_max_amount",
    senderId: "payer-1.allowance-owner.testnet",
    tokenId: "usdc.fakes.testnet",
    payee: "shop_2.vendor.testnet",
    amount: U128_MAX,
    nonce: 9_007_199_254_740_993n, // 2^53 + 1: not representable as a JS number
    maxBlockHeight: 187_654_321n,
    gas: 100n * TGAS,
    publicKeyHex: KEY_C,
  },
  {
    name: "u64_max_nonce_height_gas",
    senderId: "payer.testnet",
    tokenId: "usdc.testnet",
    payee: "payee.testnet",
    amount: 1_000_000_000_000_000_000_000_000n, // 10^24
    nonce: U64_MAX,
    maxBlockHeight: U64_MAX,
    gas: U64_MAX,
    publicKeyHex: KEY_A,
  },
  {
    name: "mainnet_implicit_payee_amount_with_zero_digits",
    senderId: "payer.allowance.near",
    tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    payee: "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
    amount: 120_000_500n,
    nonce: 187_000_000_000_001n,
    maxBlockHeight: 187_000_120n,
    gas: 15n * TGAS,
    publicKeyHex: KEY_B,
  },
];

/** A sweep: `ft_transfer_call` from the Payer Account back to the Allowance. */
type TransferCallCaseInput = Omit<CaseInput, "payee"> & { receiverId: string; msg: string };

const TRANSFER_CALL_CASES: TransferCallCaseInput[] = [
  {
    name: "sweep_back_to_allowance_60_tgas",
    senderId: "pay.allowance.testnet",
    tokenId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    receiverId: "allowance.testnet",
    amount: 4_500_000n,
    msg: "sweep:0",
    nonce: 200_000_000_000_001n,
    maxBlockHeight: 200_000_300n,
    gas: 60n * TGAS,
    publicKeyHex: KEY_A,
  },
  {
    name: "empty_msg_minimal_values",
    senderId: "a.near",
    tokenId: "usdc.near",
    receiverId: "b.near",
    amount: 1n,
    msg: "",
    nonce: 1n,
    maxBlockHeight: 1n,
    gas: 1n * TGAS,
    publicKeyHex: KEY_B,
  },
  {
    name: "u128_amount_u64_max_fields_long_msg",
    senderId: "pay.allowance-owner.testnet",
    tokenId: "usdc.fakes.testnet",
    receiverId: "allowance-owner.testnet",
    amount: U128_MAX,
    msg: "sweep:18446744073709551615",
    nonce: U64_MAX,
    maxBlockHeight: U64_MAX,
    gas: U64_MAX,
    publicKeyHex: KEY_C,
  },
  {
    name: "msg_needing_json_escapes",
    senderId: "pay.allowance.near",
    tokenId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    receiverId: "allowance.near",
    amount: 120_000_500n,
    // Quote, backslash, newline, tab, a control character and non-ASCII: JSON.stringify's escapes.
    msg: 'a "quoted" \\ path\n\twith \u0001 and café ✓',
    nonce: 187_000_000_000_001n,
    maxBlockHeight: 187_000_120n,
    gas: 100n * TGAS,
    publicKeyHex: KEY_A,
  },
];

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function buildCase(c: CaseInput) {
  // Same call shape as the x402 NEAR client: a plain object literal, so the
  // JSON key order is the literal's insertion order (receiver_id, amount).
  const transfer = actionCreators.functionCall(
    "ft_transfer",
    { receiver_id: c.payee, amount: c.amount.toString() },
    c.gas,
    ONE_YOCTO,
  );
  return {
    name: c.name,
    input: { sender_id: c.senderId, token_id: c.tokenId, payee: c.payee, ...commonInput(c) },
    expected: { ft_transfer_args_utf8: new TextDecoder().decode(transfer.functionCall!.args), ...encode(c, transfer) },
  };
}

function buildTransferCallCase(c: TransferCallCaseInput) {
  // Key order receiver_id, amount, msg: the order the contract writes.
  const transferCall = actionCreators.functionCall(
    "ft_transfer_call",
    { receiver_id: c.receiverId, amount: c.amount.toString(), msg: c.msg },
    c.gas,
    ONE_YOCTO,
  );
  return {
    name: c.name,
    input: { sender_id: c.senderId, token_id: c.tokenId, receiver_id: c.receiverId, msg: c.msg, ...commonInput(c) },
    expected: {
      ft_transfer_call_args_utf8: new TextDecoder().decode(transferCall.functionCall!.args),
      ...encode(c, transferCall),
    },
  };
}

/**
 * Encodes a one-action delegate from `c.senderId` to `c.tokenId` with the reference
 * encoder: every expected value except the args.
 */
function encode(c: Omit<CaseInput, "payee" | "name">, action: ReturnType<typeof actionCreators.functionCall>) {
  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: hexToBytes(c.publicKeyHex) });
  const delegateAction = buildDelegateAction({
    senderId: c.senderId,
    receiverId: c.tokenId,
    actions: [action],
    nonce: c.nonce,
    maxBlockHeight: c.maxBlockHeight,
    publicKey,
  });

  // encodeDelegateAction returns the NEP-461 signable message:
  // borsh(u32 prefix) ++ borsh(DelegateAction). The first 4 bytes are the prefix.
  const signableMessage = encodeDelegateAction(delegateAction);
  const delegateActionBytes = signableMessage.slice(4);
  const signedDelegate = new SignedDelegate({
    delegateAction,
    signature: new Signature({ keyType: KeyType.ED25519, data: hexToBytes(TEST_SIGNATURE_HEX) }),
  });
  const signedBytes = encodeSignedDelegate(signedDelegate);

  return {
    delegate_action_hex: bytesToHex(delegateActionBytes),
    signable_message_hex: bytesToHex(signableMessage),
    signable_message_sha256_hex: bytesToHex(sha256(signableMessage)),
    signed_delegate_action_hex: bytesToHex(signedBytes),
    signed_delegate_action_base64: Buffer.from(signedBytes).toString("base64"),
  };
}

/** The input fields every case shares, after the case-specific ones. */
function commonInput(c: Omit<CaseInput, "payee" | "name">) {
  return {
    amount: c.amount.toString(),
    nonce: c.nonce.toString(),
    max_block_height: c.maxBlockHeight.toString(),
    gas: c.gas.toString(),
    public_key_hex: c.publicKeyHex,
    signature_hex: TEST_SIGNATURE_HEX,
  };
}

function writeFixture(file: string, fixture: { description: string; encoder: string; cases: unknown[] }): void {
  const out = fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url));
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${fixture.cases.length} cases to ${out}`);
}

writeFixture("delegate-vectors.json", {
  description:
    "NEP-366 ft_transfer delegate golden vectors from @near-js/transactions. u64/u128 values are decimal strings. Generated by packages/golden-vectors; do not edit by hand.",
  encoder: "@near-js/transactions@2.5.1",
  cases: CASES.map(buildCase),
});

writeFixture("ft-transfer-call-vectors.json", {
  description:
    "NEP-366 ft_transfer_call delegate golden vectors (sweeps) from @near-js/transactions. u64/u128 values are decimal strings. Generated by packages/golden-vectors; do not edit by hand.",
  encoder: "@near-js/transactions@2.5.1",
  cases: TRANSFER_CALL_CASES.map(buildTransferCallCase),
});
