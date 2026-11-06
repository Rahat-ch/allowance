//! Pending spends: the Owner approves or rejects them, undecided ones Expire after 24
//! hours, and an approved spend Lapses unless the Agent picks up its Signed Payment within
//! an hour by re-submitting the same Request ID.
//!
//! Time-based changes (Expired, Lapsed) are applied lazily, whenever the request is
//! touched: by the Owner, by the Agent's retry, or by anyone through `expire`. Views show
//! the effective status straight away. Until a request is touched its Reservation still
//! counts against the Daily Cap, which only ever errs on the strict side.

use crate::budget::hour_of;
use crate::events;
use crate::request::{BlockedReason, SpendRequest, Status};
use crate::{Allowance, AllowanceExt};
use near_sdk::serde_json::json;
use near_sdk::{env, near};

/// A Pending spend Expires this long after it was requested.
pub const PENDING_TTL_NS: u64 = 24 * 3_600_000_000_000;
/// After approval, the Agent has this long to pick up its Signed Payment.
pub const PICKUP_WINDOW_NS: u64 = 3_600_000_000_000;

/// The status `r` has at `now`, once Expiry and Lapse are taken into account.
pub fn effective_status(r: &SpendRequest, now: u64) -> Status {
    match r.status {
        Status::Pending if r.expires_at_ns.is_some_and(|t| now >= t) => Status::Expired,
        Status::Approved if r.pickup_deadline_ns.is_some_and(|t| now >= t) => Status::Lapsed,
        s => s,
    }
}

#[near]
impl Allowance {
    /// Owner only. Approves a Pending spend; the Agent then has an hour to pick up its
    /// Signed Payment. Allowed while Paused (nothing is paid until the Agent picks it up,
    /// which is refused while Paused). Fails if the request isn't Pending, or no longer
    /// fits the current Allowlist and Hard Ceiling. Needs 1 yoctoNEAR (a wallet confirmation).
    #[payable]
    pub fn approve(&mut self, request_id: String) -> SpendRequest {
        self.assert_owner_confirmed();
        let mut r = self.decidable(&request_id);
        if let Err(reason) = self.recheck(&r) {
            env::panic_str(&format!("request no longer qualifies: {reason:?}"));
        }
        let now = env::block_timestamp();
        r.status = Status::Approved;
        r.pickup_deadline_ns = Some(now + PICKUP_WINDOW_NS);
        // Move the Reservation to the approval hour so it stays in the Daily Cap window for
        // as long as the approval can still be picked up.
        let hour = hour_of(now);
        if let Some(from) = r.reserved_hour.replace(hour) {
            self.budget.rebucket(from, hour, r.amount.0);
        }
        events::emit(
            "spend_approved",
            json!({ "request_id": r.request_id, "amount": r.amount, "payee": r.payee, "pickup_deadline_ns": r.pickup_deadline_ns }),
        );
        self.requests.insert(request_id, r.clone());
        r
    }

    /// Owner only. Rejects a Pending spend and releases its Reservation. Needs 1 yoctoNEAR.
    #[payable]
    pub fn reject(&mut self, request_id: String) -> SpendRequest {
        self.assert_owner_confirmed();
        let mut r = self.decidable(&request_id);
        self.close(&mut r, Status::Rejected, "spend_rejected");
        r
    }

    /// Anyone. Applies a due Expiry or Lapse now, releasing its Reservation. Returns the
    /// request's status afterwards.
    pub fn expire(&mut self, request_id: String) -> Status {
        let mut r = self.requests.get(&request_id).cloned().expect("unknown request");
        self.apply_time(&mut r);
        r.status
    }

    /// Pending and approved-but-not-picked-up spends as they are now (ones whose Expiry or
    /// Lapse is due are left out), oldest request first.
    pub fn list_pending(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SpendRequest> {
        let now = env::block_timestamp();
        let mut open: Vec<SpendRequest> = self
            .open_ids
            .iter()
            .filter_map(|id| self.requests.get(id))
            .filter(|r| matches!(effective_status(r, now), Status::Pending | Status::Approved))
            .cloned()
            .collect();
        open.sort_by(|a, b| (a.requested_at_ns, &a.request_id).cmp(&(b.requested_at_ns, &b.request_id)));
        open.into_iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .collect()
    }
}

impl Allowance {
    /// The request as it stands now, for the Owner to decide: applies a due Expiry and
    /// fails clearly unless it's Pending.
    fn decidable(&mut self, request_id: &str) -> SpendRequest {
        let mut r = self.requests.get(request_id).cloned().unwrap_or_else(|| env::panic_str("unknown request"));
        self.apply_time(&mut r);
        match r.status {
            Status::Pending => r,
            Status::Expired => env::panic_str("request expired"),
            Status::Lapsed => env::panic_str("request lapsed"),
            Status::Blocked => env::panic_str("request was blocked"),
            _ => env::panic_str("request already decided"),
        }
    }

    /// Allowlist and Hard Ceiling as they are now (approval and Pickup re-check both).
    fn recheck(&self, r: &SpendRequest) -> Result<(), BlockedReason> {
        if !self.allowlist.contains(&r.payee) {
            return Err(BlockedReason::UnknownPayee);
        }
        if r.amount.0 > self.policy.hard_ceiling.0 {
            return Err(BlockedReason::OverHardCeiling);
        }
        Ok(())
    }

    /// Stores `r` with a due Expiry or Lapse applied (and its Reservation released).
    pub(crate) fn apply_time(&mut self, r: &mut SpendRequest) {
        match effective_status(r, env::block_timestamp()) {
            Status::Expired if r.status != Status::Expired => self.close(r, Status::Expired, "spend_expired"),
            Status::Lapsed if r.status != Status::Lapsed => self.close(r, Status::Lapsed, "spend_lapsed"),
            _ => {}
        }
    }

    /// Ends a Pending or approved-unsigned spend without paying it: releases its
    /// Reservation (Velocity is never given back) and its Held funds, and stores it.
    pub(crate) fn close(&mut self, r: &mut SpendRequest, status: Status, event: &str) {
        if let Some(hour) = r.reserved_hour.take() {
            self.budget.release(hour, r.amount.0);
        }
        self.funds.unhold(r.amount.0);
        r.status = status;
        self.open_ids.remove(&r.request_id);
        events::emit(event, json!({ "request_id": r.request_id, "amount": r.amount, "payee": r.payee }));
        self.requests.insert(r.request_id.clone(), r.clone());
    }

    /// An identical re-submission of a stored request: applies Expiry and Lapse, and picks
    /// up an approved spend's Signed Payment. Everything else returns the request as is.
    pub(crate) fn resubmitted(&mut self, request_id: &str, max_timeout_blocks: u64) -> SpendRequest {
        let mut r = self.requests.get(request_id).cloned().expect("stored");
        self.apply_time(&mut r);
        if r.status != Status::Approved {
            return r;
        }
        // Pickup. Refusals leave the approval in place (its deadline keeps running) and
        // say why in the returned copy only.
        let refusal = if self.revoked {
            Some(BlockedReason::Revoked)
        } else if self.paused {
            Some(BlockedReason::Paused)
        } else if max_timeout_blocks == 0 {
            Some(BlockedReason::InvalidRequest)
        } else {
            self.recheck(&r).err()
        };
        if let Some(reason) = refusal {
            return SpendRequest { blocked_reason: Some(reason), ..r };
        }
        // Before changing anything: a busy pool refuses the whole call, leaving the approval.
        self.lease_signing_key(&r.request_id);
        // Like a new request: a timeout beyond the Policy maximum is clamped to it.
        r.max_timeout_blocks = max_timeout_blocks.min(self.policy.max_timeout_blocks);
        r.status = Status::Funding;
        r.pickup_deadline_ns = None;
        self.open_ids.remove(&r.request_id);
        events::emit("spend_picked_up", json!({ "request_id": r.request_id, "amount": r.amount, "payee": r.payee }));
        self.requests.insert(r.request_id.clone(), r.clone());
        self.issue_signed_payment(&r.request_id);
        // Funding can fail at once (not enough USDC): return the request as stored.
        self.requests.get(&r.request_id).cloned().expect("stored")
    }
}
