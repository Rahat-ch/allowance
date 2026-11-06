//! The Owner's controls over the Agent: Pause, Revoke, removing a Payee, and replacing
//! the Agent's key.
//!
//! Tightening is cheap and loosening needs a confirmation: `pause` and `remove_payee`
//! work with any Owner key (a web page's function-call key can stop the Agent quickly),
//! while `unpause`, `revoke` and `replace_agent_key` need exactly 1 yoctoNEAR (a wallet
//! confirmation or full-access key).
//!
//! Signed Payments already issued can't be cancelled by any of these: they are complete,
//! signed x402 payments and stay valid until their `max_block_height` (a few minutes at
//! most). Everything not yet signed is stopped.

use crate::events;
use crate::request::Status;
use crate::{AGENT_METHOD, Allowance, AllowanceExt};
use near_sdk::serde_json::json;
use near_sdk::{AccountId, NearToken, Promise, PublicKey, env, near, require};

#[near]
impl Allowance {
    /// Owner. Blocks every new Spend Request (Paused) and every Pickup until `unpause`.
    /// The Owner can still approve and reject.
    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        if !self.paused {
            self.paused = true;
            events::emit("paused", json!({}));
        }
    }

    /// Owner, with 1 yoctoNEAR. Lets the Agent spend again (not after Revoke).
    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_confirmed();
        require!(!self.revoked, "the Agent is revoked");
        if self.paused {
            self.paused = false;
            events::emit("unpaused", json!({}));
        }
    }

    /// Owner, with 1 yoctoNEAR. Permanently ends the Agent: deletes its key and cancels
    /// every Pending and approved-but-not-picked-up spend. Issued Signed Payments stay
    /// valid until they expire. A revoked Allowance refuses every Spend Request even if a
    /// key were somehow re-added; spending again needs a new Allowance.
    #[payable]
    pub fn revoke(&mut self) -> Promise {
        self.assert_owner_confirmed();
        require!(!self.revoked, "the Agent is already revoked");
        self.revoked = true;
        let open: Vec<String> = self.open_ids.iter().cloned().collect();
        let cancelled = open.len();
        for id in open {
            let mut r = self.requests.get(&id).cloned().expect("open request is stored");
            self.close(&mut r, Status::Cancelled, "spend_cancelled");
        }
        events::emit("revoked", json!({ "cancelled": cancelled }));
        Promise::new(env::current_account_id()).delete_key(self.agent_key.clone())
    }

    /// Owner. Takes `payee` off the Allowlist, rejecting its Pending spends and cancelling
    /// its approved-but-not-picked-up ones (their Reservations and Held funds are released).
    #[payable]
    pub fn remove_payee(&mut self, payee: AccountId) {
        self.assert_owner();
        if !self.allowlist.remove(&payee) {
            return;
        }
        let affected: Vec<String> = self
            .open_ids
            .iter()
            .filter(|id| self.requests.get(*id).is_some_and(|r| r.payee == payee))
            .cloned()
            .collect();
        for id in &affected {
            let mut r = self.requests.get(id).cloned().expect("open request is stored");
            let (status, event) = match r.status {
                Status::Pending => (Status::Rejected, "spend_rejected"),
                _ => (Status::Cancelled, "spend_cancelled"),
            };
            self.close(&mut r, status, event);
        }
        events::emit("payee_removed", json!({ "payee": payee, "cancelled": affected }));
    }

    /// Owner, with 1 yoctoNEAR. Replaces the Agent's key with `public_key` (a fresh key with
    /// `allowance` yoctoNEAR of gas, default 1 NEAR), e.g. when the old one ran out of gas
    /// allowance. Not possible after Revoke.
    #[payable]
    pub fn replace_agent_key(&mut self, public_key: PublicKey, allowance: Option<NearToken>) -> Promise {
        self.assert_owner_confirmed();
        require!(!self.revoked, "the Agent is revoked");
        let allowance = allowance.unwrap_or(crate::DEFAULT_AGENT_ALLOWANCE);
        let old = std::mem::replace(&mut self.agent_key, public_key.clone());
        events::emit("agent_key_replaced", json!({ "old": old, "new": public_key }));
        let account = env::current_account_id();
        // Delete then add in one batch (also resets the allowance if it's the same key).
        Promise::new(account.clone()).delete_key(old).add_access_key_allowance(
            public_key,
            near_sdk::Allowance::limited(allowance).expect("allowance must be positive"),
            account,
            AGENT_METHOD,
        )
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked
    }

    pub fn get_agent_key(&self) -> PublicKey {
        self.agent_key.clone()
    }
}
