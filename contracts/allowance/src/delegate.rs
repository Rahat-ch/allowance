//! The bytes of a Signed Payment: the x402 `exact` payment for NEAR, a NEP-366
//! `SignedDelegateAction` from the Payer Account carrying exactly one
//! `ft_transfer` of the stablecoin to a Payee (ADR 0003). Also the bytes of a
//! sweep: the same envelope carrying one `ft_transfer_call` back to the
//! Allowance.
//!
//! The x402 facilitator decodes and re-encodes these bytes with the official
//! NEAR JS encoder (`@near-js/transactions`) and checks the signature against
//! them, so every layout here must match nearcore byte for byte. Golden vectors
//! from that encoder live in `packages/golden-vectors/fixtures` and are checked
//! by `tests/delegate_golden_vectors.rs`.
//!
//! This module is pure: no `env` calls, so it runs on the host in `cargo test`
//! and in the contract on wasm32. It builds bytes only; signing (Chain
//! Signatures) and nonce/expiry choice live elsewhere.
//!
//! The borsh structs below are minimal hand-rolled mirrors of nearcore types,
//! covering only what one ed25519 single-function-call delegate needs. Sources
//! (nearcore `master`):
//! - `core/primitives/src/action/delegate.rs`: `DelegateAction`,
//!   `SignedDelegateAction`, `NonDelegateAction`, `get_nep461_hash`.
//! - `core/primitives/src/action/mod.rs`: `Action` (borsh discriminant
//!   `FunctionCall = 2`), `FunctionCallAction`.
//! - `core/primitives/src/signable_message.rs`: NEP-461 `MessageDiscriminant`.
//! - `core/crypto/src/signature.rs`: borsh of `PublicKey` / `Signature`
//!   (`KeyType::ED25519 = 0` tag byte, then raw key/signature bytes).

use borsh::BorshSerialize;
use near_sdk::AccountId;
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json;
use sha2::{Digest, Sha256};

/// NEP-461 on-chain message discriminant for NEP-366 meta transactions:
/// `MIN_ON_CHAIN_DISCRIMINANT (1 << 30) + NEP_366_META_TRANSACTIONS (366)`
/// = `0x4000_016E`, borsh-encoded as little-endian u32 `6e 01 00 40`
/// (nearcore `signable_message.rs`, `SignableMessageType::DelegateAction`).
/// The V2 delegate (`DelegateActionV2`, NEP-611 gas keys) uses a different
/// discriminant and is not what x402 `exact` accepts.
const NEP_366_SIGNABLE_DISCRIMINANT: u32 = (1 << 30) + 366;

/// NEP-141 transfer method.
const FT_TRANSFER: &str = "ft_transfer";

/// NEP-141 transfer-and-notify method (a sweep's single action).
const FT_TRANSFER_CALL: &str = "ft_transfer_call";

/// NEP-141 `ft_transfer` and `ft_transfer_call` require exactly 1 yoctoNEAR
/// attached; the x402 spec rejects any other deposit.
const ONE_YOCTO: u128 = 1;

/// One `ft_transfer` of `amount` from the Payer Account (`sender_id`) to a
/// Payee, on the stablecoin contract `token_id`, as a NEP-366 delegate action.
pub struct FtTransferDelegate {
    /// The Payer Account: `DelegateAction.sender_id`, and the account debited.
    pub sender_id: AccountId,
    /// The stablecoin (NEP-141) contract: `DelegateAction.receiver_id`, which
    /// x402 checks equals `PaymentRequirements.asset`.
    pub token_id: AccountId,
    /// The Payee: `ft_transfer` `receiver_id`, checked against `payTo`.
    pub payee: AccountId,
    /// Token amount in atomic units, sent as a decimal string in the args.
    pub amount: u128,
    /// Access-key nonce of `public_key` on the Payer Account. Must exceed the
    /// key's current nonce.
    pub nonce: u64,
    /// Last block height at which the delegate is valid.
    pub max_block_height: u64,
    /// Gas for the inner `ft_transfer`, in raw gas units (1 TGas = 10^12),
    /// not TGas.
    pub gas: u64,
    /// The Payer Account's ed25519 public key that signs this delegate.
    pub public_key: [u8; 32],
}

/// One `ft_transfer_call` of `amount` from the Payer Account (`sender_id`) to
/// `receiver_id` with `msg`, on the stablecoin contract `token_id`, as a
/// NEP-366 delegate action. A sweep uses it to send uncollected USDC back to
/// the Allowance, whose `ft_on_transfer` credits it.
pub struct FtTransferCallDelegate {
    /// The Payer Account: `DelegateAction.sender_id`, and the account debited.
    pub sender_id: AccountId,
    /// The stablecoin (NEP-141) contract: `DelegateAction.receiver_id`.
    pub token_id: AccountId,
    /// `ft_transfer_call` `receiver_id`: the account notified through
    /// `ft_on_transfer`.
    pub receiver_id: AccountId,
    /// Token amount in atomic units, sent as a decimal string in the args.
    pub amount: u128,
    /// `ft_transfer_call` `msg`, handed to `ft_on_transfer` unchanged.
    pub msg: String,
    /// Access-key nonce of `public_key` on the Payer Account. Must exceed the
    /// key's current nonce.
    pub nonce: u64,
    /// Last block height at which the delegate is valid.
    pub max_block_height: u64,
    /// Gas for the inner `ft_transfer_call` (raw gas units). It must cover the
    /// receiver's `ft_on_transfer` and the token's resolve callback.
    pub gas: u64,
    /// The Payer Account's ed25519 public key that signs this delegate.
    pub public_key: [u8; 32],
}

/// The `ft_transfer` JSON args. Field order here is the JSON key order:
/// `{"receiver_id":"<payee>","amount":"<u128 decimal>"}`, compact (no
/// whitespace), the same bytes the x402 NEAR client produces with
/// `JSON.stringify({ receiver_id, amount })`. The order does not affect x402
/// verification (it parses the JSON), but it pins the signed bytes.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferArgs<'a> {
    receiver_id: &'a str,
    amount: String,
}

/// The `ft_transfer_call` JSON args, in this key order:
/// `{"receiver_id":"<receiver>","amount":"<u128 decimal>","msg":"<msg>"}`,
/// compact, the bytes `JSON.stringify({ receiver_id, amount, msg })` writes.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferCallArgs<'a> {
    receiver_id: &'a str,
    amount: String,
    msg: &'a str,
}

impl FtTransferDelegate {
    /// The `ft_transfer` args as UTF-8 JSON, see [`FtTransferArgs`] for the
    /// exact form.
    pub fn ft_transfer_args(&self) -> Vec<u8> {
        let args = FtTransferArgs {
            receiver_id: self.payee.as_str(),
            amount: self.amount.to_string(),
        };
        serde_json::to_vec(&args).expect("ft_transfer args always serialize")
    }

    fn call(&self) -> Call<'_> {
        Call {
            sender_id: self.sender_id.as_str(),
            receiver_id: self.token_id.as_str(),
            method_name: FT_TRANSFER,
            args: self.ft_transfer_args(),
            gas: self.gas,
            nonce: self.nonce,
            max_block_height: self.max_block_height,
            public_key: self.public_key,
        }
    }
}

impl FtTransferCallDelegate {
    /// The `ft_transfer_call` args as UTF-8 JSON, see [`FtTransferCallArgs`]
    /// for the exact form.
    pub fn ft_transfer_call_args(&self) -> Vec<u8> {
        let args = FtTransferCallArgs {
            receiver_id: self.receiver_id.as_str(),
            amount: self.amount.to_string(),
            msg: &self.msg,
        };
        serde_json::to_vec(&args).expect("ft_transfer_call args always serialize")
    }

    fn call(&self) -> Call<'_> {
        Call {
            sender_id: self.sender_id.as_str(),
            receiver_id: self.token_id.as_str(),
            method_name: FT_TRANSFER_CALL,
            args: self.ft_transfer_call_args(),
            gas: self.gas,
            nonce: self.nonce,
            max_block_height: self.max_block_height,
            public_key: self.public_key,
        }
    }
}

/// The encodings every delegate type offers, built from its `call()`.
macro_rules! delegate_encodings {
    ($ty:ty) => {
        impl $ty {
            /// `borsh(DelegateAction)`: the delegate on its own, without the
            /// NEP-461 prefix.
            pub fn delegate_action_bytes(&self) -> Vec<u8> {
                to_borsh(&self.call().delegate_action())
            }

            /// The NEP-461 signable message:
            /// `borsh(u32 NEP_366_SIGNABLE_DISCRIMINANT) ++ borsh(DelegateAction)`
            /// (nearcore `SignableMessage { discriminant, msg }`).
            pub fn signable_message(&self) -> Vec<u8> {
                let mut message = to_borsh(&NEP_366_SIGNABLE_DISCRIMINANT);
                message.extend(self.delegate_action_bytes());
                message
            }

            /// `sha256(signable_message())`: the 32 bytes the Payer Account key
            /// signs with ed25519 (nearcore `DelegateAction::get_nep461_hash`).
            pub fn signable_hash(&self) -> [u8; 32] {
                Sha256::digest(self.signable_message()).into()
            }

            /// `borsh(SignedDelegateAction { delegate_action, signature })` with
            /// an ed25519 `signature` over [`Self::signable_hash`].
            pub fn signed_delegate_action_bytes(&self, signature: &[u8; 64]) -> Vec<u8> {
                to_borsh(&SignedDelegateAction {
                    delegate_action: self.call().delegate_action(),
                    signature: Signature::Ed25519(*signature),
                })
            }

            /// Standard (padded) base64 of [`Self::signed_delegate_action_bytes`].
            /// For a Signed Payment this is the `payload.signedDelegateAction`
            /// string of an x402 NEAR `exact` payment.
            pub fn signed_delegate_action_base64(&self, signature: &[u8; 64]) -> String {
                BASE64.encode(self.signed_delegate_action_bytes(signature))
            }
        }
    };
}

delegate_encodings!(FtTransferDelegate);
delegate_encodings!(FtTransferCallDelegate);

/// One function call with 1 yoctoNEAR attached, from `sender_id` to
/// `receiver_id`: what both delegate types reduce to before encoding.
struct Call<'a> {
    sender_id: &'a str,
    receiver_id: &'a str,
    method_name: &'static str,
    args: Vec<u8>,
    gas: u64,
    nonce: u64,
    max_block_height: u64,
    public_key: [u8; 32],
}

impl<'a> Call<'a> {
    fn delegate_action(self) -> DelegateAction<'a> {
        DelegateAction {
            sender_id: self.sender_id,
            receiver_id: self.receiver_id,
            actions: vec![NonDelegateAction::FunctionCall(FunctionCallAction {
                method_name: self.method_name,
                args: self.args,
                gas: self.gas,
                deposit: ONE_YOCTO,
            })],
            nonce: self.nonce,
            max_block_height: self.max_block_height,
            public_key: PublicKey::Ed25519(self.public_key),
        }
    }
}

fn to_borsh(value: &impl BorshSerialize) -> Vec<u8> {
    borsh::to_vec(value).expect("borsh into a Vec cannot fail")
}

/// nearcore `delegate::DelegateAction`. `AccountId` borsh-encodes as a string
/// (u32 LE length + UTF-8); `Nonce` and `BlockHeight` are u64 LE.
#[derive(BorshSerialize)]
struct DelegateAction<'a> {
    sender_id: &'a str,
    receiver_id: &'a str,
    actions: Vec<NonDelegateAction<'a>>,
    nonce: u64,
    max_block_height: u64,
    public_key: PublicKey,
}

/// nearcore `delegate::NonDelegateAction(Action)` is a transparent wrapper:
/// borsh is the inner `Action` enum (u8 variant index, then the variant). Only
/// the `FunctionCall` variant, index 2 in `action/mod.rs`, is needed.
#[derive(BorshSerialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
enum NonDelegateAction<'a> {
    FunctionCall(FunctionCallAction<'a>) = 2,
}

/// nearcore `action::FunctionCallAction`: `method_name: String`,
/// `args: Vec<u8>` (u32 LE length + bytes), `gas: Gas` (u64 LE, raw gas
/// units), `deposit: Balance` (u128 LE, yoctoNEAR).
#[derive(BorshSerialize)]
struct FunctionCallAction<'a> {
    method_name: &'a str,
    args: Vec<u8>,
    gas: u64,
    deposit: u128,
}

/// nearcore `delegate::SignedDelegateAction`.
#[derive(BorshSerialize)]
struct SignedDelegateAction<'a> {
    delegate_action: DelegateAction<'a>,
    signature: Signature,
}

/// near-crypto `PublicKey` borsh: key-type byte (`ED25519 = 0`) then the 32
/// raw key bytes.
#[derive(BorshSerialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
enum PublicKey {
    Ed25519([u8; 32]) = 0,
}

/// near-crypto `Signature` borsh: key-type byte (`ED25519 = 0`) then the 64
/// raw signature bytes.
#[derive(BorshSerialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
enum Signature {
    Ed25519([u8; 64]) = 0,
}
