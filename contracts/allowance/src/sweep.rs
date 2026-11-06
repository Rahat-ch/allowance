//! Sweeps: getting USDC that Signed Payments left in the Payer Account back into the
//! Allowance.
//!
//! A Signed Payment moves its amount into the Payer Account when it is issued. If the
//! Payee never collects it, that USDC stays there after the payment expires, out of the
//! Allowance's ledger. A sweep is a NEP-366 delegate from the Payer Account to the USDC
//! contract with one action, `ft_transfer_call(receiver_id = the Allowance, amount,
//! msg = "sweep:<id>")`, built and signed by this contract through Chain Signatures
//! exactly like a Signed Payment. Anyone can relay it; the USDC comes back through
//! `ft_on_transfer` and is credited, so it becomes Withdrawable again.
//!
//! **Key.** A sweep leases a Payer Account key from the same pool as Signed Payments, so it
//! only ever gets a key whose Signed Payment has expired (or that never had one). Its nonce
//! is above every nonce issued on that key, so once relayed it also invalidates any older
//! delegate there. When every key holds an unexpired Signed Payment, `sweep` is refused as
//! busy and changes nothing.
//!
//! **Amount.** The contract can't see settlement (ADR 0003), so it can't know from its own
//! ledger how much is left in the Payer Account: "funded minus collected" would need the
//! collected part, which only the token knows. So it asks the token: `sweep` reads
//! `ft_balance_of(Payer Account)` and, in the callback, takes off the amounts of every
//! Signed Payment (and sweep) whose delegate may still move money (see
//! [`KeyPool::live_holders`](crate::keys::KeyPool::live_holders)). The sweep is the Owner's
//! amount capped to that, or all of it if the Owner gave none. Nothing to sweep refuses it.
//!
//! The balance read and the deduction happen in different blocks, so everything that can
//! move USDC between them must be counted:
//! - A payment funded or issued in between is deducted (computed in the callback), which
//!   can only make the sweep smaller.
//! - Another sweep could leave in between, because anyone can relay its delegate at any
//!   moment. So only one sweep may be outstanding: a new one is refused as busy while the
//!   last is being checked or signed, or is signed and neither settled nor past its
//!   `max_block_height` + `SETTLEMENT_SLACK_BLOCKS`. As a second guard a sweep stays
//!   deducted until it expires, or until it settled before the current sweep was requested.
//! - Payments and sweeps that expired are deducted for `SETTLEMENT_SLACK_BLOCKS` more,
//!   since a transfer they started may still land.
//!
//! **Budget.** Swept Signed Payments keep counting against the Daily Cap for their window
//! (ADR 0001): a sweep recovers funds, never cap. Nothing here touches the Budget.
//!
//! **Settlement.** The Allowance learns a sweep was relayed when its USDC arrives
//! (`ft_on_transfer` from the asset, sender the Payer Account, `msg` `sweep:<id>`). Then it
//! is Settled and its key is given back at once: its nonce is used up on chain.
//!
//! **State.** Sweeps add contract state (the `sweeps` vector and the key pool's recent-issue
//! records), so an Allowance deployed before them needs a fresh deploy; there is no
//! migration. The account is locked (ADR 0004), so a new deploy is the only way anyway.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, NearToken, PromiseOrValue, env, near, require};

use crate::delegate::FtTransferCallDelegate;
use crate::keys::{FUNDING_LEASE_BLOCKS, SETTLEMENT_SLACK_BLOCKS};
use crate::{
    Allowance, AllowanceExt, SIGN_GAS, SIGN_RESPONSE_MAX_BYTES, SignPayload, SignRequest, SignResponse,
    derivation_path, ed25519_string, events, ext_ft, ext_signer,
};

/// How long a sweep's delegate stays valid. The Owner's script relays it as soon as it is
/// signed; until it settles or expires, its key is leased and its amount is deducted from
/// any other sweep.
pub const SWEEP_TIMEOUT_BLOCKS: u64 = 300;
/// Gas for the sweep's inner `ft_transfer_call`: the token's own work, the Allowance's
/// `ft_on_transfer` and the token's resolve callback.
const SWEEP_TRANSFER_CALL_GAS: u64 = 60_000_000_000_000;
const BALANCE_OF_GAS: Gas = Gas::from_tgas(5);
/// `on_sweep_balance` builds the delegate and asks the signer (SIGN_GAS + ON_SWEEP_SIGNED_GAS).
const ON_SWEEP_BALANCE_GAS: Gas = Gas::from_tgas(100);
const ON_SWEEP_SIGNED_GAS: Gas = Gas::from_tgas(30);
/// Holder ids of sweep key leases. Request IDs can't contain ':', so these never collide.
const HOLDER_PREFIX: &str = "sweep:";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SweepStatus {
    /// Reading the Payer Account's USDC balance.
    Checking,
    /// Sent to the signer.
    Signing,
    /// Ready to relay: `signed_delegate_action` is set.
    Signed,
    /// Its USDC came back and was credited.
    Settled,
    /// Nothing was signed: nothing to sweep, or the balance couldn't be read.
    Refused,
    /// The signer didn't deliver a valid signature.
    SignatureUnavailable,
    /// Signed but never relayed before its `max_block_height` (shown by `get_sweep`).
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Sweep {
    pub id: u64,
    pub status: SweepStatus,
    /// What the Owner asked for; None means everything sweepable.
    pub requested_amount: Option<U128>,
    /// What the delegate moves; 0 until checked (and if Refused).
    pub amount: U128,
    /// The Payer Account's USDC balance as the token reported it.
    pub payer_balance: Option<U128>,
    /// Amounts of Signed Payments and sweeps that may still move money, taken off the
    /// balance.
    pub outstanding: Option<U128>,
    pub refused_reason: Option<String>,
    /// Payer Account key leased to it (derivation path `x402/<index>`).
    pub key_index: u32,
    pub public_key: String,
    pub nonce: Option<u64>,
    pub max_block_height: Option<u64>,
    /// Base64 borsh `SignedDelegateAction`; relay it as a transaction's single Delegate action.
    pub signed_delegate_action: Option<String>,
    /// Block timestamp (ns) when the Owner asked for it.
    pub requested_at_ns: u64,
    pub requested_at_height: u64,
    /// Block height at which its USDC arrived back (Settled).
    pub settled_at_height: Option<u64>,
}

impl Sweep {
    /// Still being checked or signed. A callback that never ran (out of gas) would leave it
    /// so forever; past its key lease's deadline it no longer blocks a new sweep.
    fn in_progress(&self, height: u64) -> bool {
        match self.status {
            SweepStatus::Checking => height <= self.requested_at_height + FUNDING_LEASE_BLOCKS,
            // Its delegate exists (or a late signature may still appear) and may still move
            // money: anyone can relay it at any moment, so no other sweep may read the
            // balance until it has settled or expired.
            SweepStatus::Signing | SweepStatus::Signed | SweepStatus::SignatureUnavailable => self
                .max_block_height
                .is_some_and(|h| height <= h.saturating_add(SETTLEMENT_SLACK_BLOCKS)),
            SweepStatus::Settled | SweepStatus::Refused | SweepStatus::Expired => false,
        }
    }
}

#[near]
impl Allowance {
    /// Owner only, with exactly 1 yoctoNEAR. Starts a sweep of up to `amount` USDC (all
    /// that is sweepable if None) from the Payer Account back to the Allowance and returns
    /// its id. It is checked and signed asynchronously: poll `get_sweep` until it is
    /// `Signed` (then relay `signed_delegate_action`) or `Refused`.
    ///
    /// Panics "busy: ..." (changing nothing) while every Payer Account key holds an
    /// unexpired Signed Payment, and while the previous sweep is outstanding: being checked
    /// or signed, or signed and neither settled nor expired (see the module docs).
    /// Attach about 150 TGas.
    #[payable]
    pub fn sweep(&mut self, amount: Option<U128>) -> u64 {
        self.assert_owner_confirmed();
        require!(!self.keys.is_empty(), "no Payer Account yet");
        require!(amount.is_none_or(|a| a.0 > 0), "amount must be positive");
        // Only the latest sweep can still be in progress: this refuses a new one meanwhile.
        let last = self.sweeps.len().checked_sub(1).and_then(|i| self.sweeps.get(i));
        if let Some(last) = last.filter(|s| s.in_progress(env::block_height())) {
            env::panic_str(&format!("busy: sweep {} is still outstanding (being checked or signed, or signed and not yet settled or expired)", last.id));
        }
        let id = self.sweeps.len() as u64;
        let key_index = self.lease_signing_key(&holder(id));
        self.sweeps.push(Sweep {
            id,
            status: SweepStatus::Checking,
            requested_amount: amount,
            amount: U128(0),
            payer_balance: None,
            outstanding: None,
            refused_reason: None,
            key_index,
            public_key: ed25519_string(&self.keys.public_key(key_index)),
            nonce: None,
            max_block_height: None,
            signed_delegate_action: None,
            requested_at_ns: env::block_timestamp(),
            requested_at_height: env::block_height(),
            settled_at_height: None,
        });
        events::emit("sweep_requested", json!({ "id": id, "requested_amount": amount, "key_index": key_index }));
        ext_ft::ext(self.asset_id.clone())
            .with_static_gas(BALANCE_OF_GAS)
            .ft_balance_of(self.payer_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_SWEEP_BALANCE_GAS).on_sweep_balance(id))
            .detach();
        id
    }

    /// The sweep as it is now (a Signed one past its `max_block_height` shows Expired).
    pub fn get_sweep(&self, id: u64) -> Option<Sweep> {
        let height = env::block_height();
        self.sweeps.get(id as u32).map(|s| {
            let expired = s.status == SweepStatus::Signed && s.max_block_height.is_some_and(|h| height > h);
            Sweep { status: if expired { SweepStatus::Expired } else { s.status }, ..s.clone() }
        })
    }

    /// The Payer Account's balance is in (or not): fixes the amount, then signs.
    #[private]
    pub fn on_sweep_balance(&mut self, id: u64) -> PromiseOrValue<()> {
        let balance = env::promise_result_checked(0, 128)
            .ok()
            .and_then(|raw| near_sdk::serde_json::from_slice::<U128>(&raw).ok());
        let Some(balance) = balance else {
            self.refuse_sweep(id, "the Payer Account's USDC balance couldn't be read".into());
            return PromiseOrValue::Value(());
        };
        let height = env::block_height();
        let own = holder(id);
        // The balance was read after this sweep was requested, so whatever settled before
        // then is already out of it.
        let read_after = self.sweep_record(id).requested_at_height;
        let outstanding: u128 = self
            .keys
            .live_holders(height)
            .filter(|h| *h != own)
            .map(|h| self.amount_held_by(h, read_after))
            .sum();
        let mut s = self.sweep_record(id);
        let sweepable = balance.0.saturating_sub(outstanding);
        let amount = s.requested_amount.map_or(sweepable, |r| r.0.min(sweepable));
        s.payer_balance = Some(balance);
        s.outstanding = Some(U128(outstanding));
        if amount == 0 {
            self.save_sweep(s);
            self.refuse_sweep(
                id,
                format!("nothing to sweep: {} in the Payer Account, {} for unexpired Signed Payments", balance.0, outstanding),
            );
            return PromiseOrValue::Value(());
        }
        let issued = self.keys.issue(&own, height, SWEEP_TIMEOUT_BLOCKS);
        s.amount = U128(amount);
        s.nonce = Some(issued.nonce);
        s.max_block_height = Some(issued.max_block_height);
        s.status = SweepStatus::Signing;
        let hash = self.sweep_delegate(&s).signable_hash();
        self.save_sweep(s);
        PromiseOrValue::Promise(
            ext_signer::ext(self.signer_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(SIGN_GAS)
                .sign(SignRequest {
                    path: derivation_path(issued.key_index),
                    payload_v2: SignPayload::Eddsa(hex::encode(hash)),
                    domain_id: self.domain_id,
                })
                .then(Self::ext(env::current_account_id()).with_static_gas(ON_SWEEP_SIGNED_GAS).on_sweep_signed(id)),
        )
    }

    /// Verifies the signer's answer and stores the signed delegate. Like `on_signed`, it
    /// parses leniently so a bad answer ends the sweep instead of leaving it Signing.
    #[private]
    pub fn on_sweep_signed(&mut self, id: u64) {
        let signed = env::promise_result_checked(0, SIGN_RESPONSE_MAX_BYTES)
            .ok()
            .and_then(|raw| near_sdk::serde_json::from_slice::<SignResponse>(&raw).ok());
        let mut s = self.sweep_record(id);
        let d = self.sweep_delegate(&s);
        let public_key = self.keys.public_key(s.key_index);
        let sig: Option<[u8; 64]> = signed
            .filter(|r| r.scheme == "Ed25519")
            .and_then(|r| r.signature.try_into().ok())
            .filter(|sig| env::ed25519_verify(sig, &d.signable_hash(), &public_key));
        let data = json!({
            "id": id, "amount": s.amount, "key_index": s.key_index,
            "nonce": s.nonce, "max_block_height": s.max_block_height,
        });
        match sig {
            Some(sig) => {
                s.signed_delegate_action = Some(d.signed_delegate_action_base64(&sig));
                s.status = SweepStatus::Signed;
                events::emit("sweep_signed", data);
            }
            // The key stays leased until max_block_height: a late signature is still usable.
            None => {
                s.status = SweepStatus::SignatureUnavailable;
                events::emit("sweep_signature_unavailable", data);
            }
        }
        self.save_sweep(s);
    }
}

impl Allowance {
    /// Called from `ft_on_transfer` for USDC the Payer Account sent: if it is a sweep
    /// arriving, marks it Settled and gives its key back (its nonce is now used on chain).
    pub(crate) fn sweep_arrived(&mut self, sender_id: &AccountId, amount: U128, msg: &str) {
        if *sender_id != self.payer_account_id() {
            return;
        }
        let Some(id) = msg.strip_prefix(HOLDER_PREFIX).and_then(|n| n.parse::<u64>().ok()) else {
            return;
        };
        let Some(mut s) = self.sweeps.get(id as u32).cloned() else {
            return;
        };
        if s.amount != amount || s.status == SweepStatus::Settled {
            return;
        }
        s.status = SweepStatus::Settled;
        s.settled_at_height = Some(env::block_height());
        self.keys.release(&holder(id));
        events::emit("sweep_settled", json!({ "id": id, "amount": amount }));
        self.save_sweep(s);
    }

    fn refuse_sweep(&mut self, id: u64, reason: String) {
        let mut s = self.sweep_record(id);
        self.keys.release(&holder(id));
        s.status = SweepStatus::Refused;
        events::emit("sweep_refused", json!({ "id": id, "reason": reason }));
        s.refused_reason = Some(reason);
        self.save_sweep(s);
    }

    /// The amount a key holder's delegate can still move: a Spend Request's (the Allowance
    /// can't tell whether it was collected), or a sweep's until it has settled.
    ///
    /// A sweep is deducted until it has expired (`live_holders`) or settled. One that
    /// settled at or after `read_after` (the height the current sweep was requested at) is
    /// still deducted: its USDC may have left after the balance was read. (While a sweep is
    /// outstanding no other may start, see `Sweep::in_progress`; this is the second guard.)
    fn amount_held_by(&self, holder_id: &str, read_after: u64) -> u128 {
        match holder_id.strip_prefix(HOLDER_PREFIX) {
            Some(n) => n
                .parse::<u32>()
                .ok()
                .and_then(|i| self.sweeps.get(i))
                .filter(|s| s.settled_at_height.is_none_or(|h| h >= read_after))
                .map_or(0, |s| s.amount.0),
            None => self.requests.get(holder_id).map_or(0, |r| r.amount.0),
        }
    }

    fn sweep_record(&self, id: u64) -> Sweep {
        self.sweeps.get(id as u32).cloned().expect("unknown sweep")
    }

    fn save_sweep(&mut self, s: Sweep) {
        let i = s.id as u32;
        self.sweeps.set(i, s);
    }

    fn sweep_delegate(&self, s: &Sweep) -> FtTransferCallDelegate {
        FtTransferCallDelegate {
            sender_id: self.payer_account_id(),
            token_id: self.asset_id.clone(),
            receiver_id: env::current_account_id(),
            amount: s.amount.0,
            msg: holder(s.id),
            nonce: s.nonce.expect("sweep issued before signing"),
            max_block_height: s.max_block_height.expect("sweep issued before signing"),
            gas: SWEEP_TRANSFER_CALL_GAS,
            public_key: self.keys.public_key(s.key_index),
        }
    }
}

/// Key lease holder id and `ft_transfer_call` msg of sweep `id`.
fn holder(id: u64) -> String {
    format!("{HOLDER_PREFIX}{id}")
}
