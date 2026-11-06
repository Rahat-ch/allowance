//! Spend Requests: what the Agent asked for, its Outcome, and where it is now.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// Longest memo the Agent may attach, in bytes.
pub const MAX_MEMO_BYTES: usize = 64;

/// The Outcome a Spend Request got when it was submitted.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    Approved,
    Pending,
    Blocked,
}

/// Why a Spend Request was Blocked. Machine-readable for the Agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BlockedReason {
    UnknownPayee,
    OverHardCeiling,
    DailyCapExceeded,
    VelocityExceeded,
    Paused,
    Revoked,
    IdempotencyConflict,
    InvalidRequest,
}

/// Extra detail for limits the Agent can wait out.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct LimitDetail {
    pub used: U128,
    pub limit: U128,
    /// Block timestamp (ns) from which a retry can fit; None if it never can.
    pub retry_after_ns: Option<u64>,
}

/// Where a Spend Request is in its lifecycle.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// Never paid.
    Blocked,
    /// Waiting for the Owner; holds a Reservation.
    Pending,
    /// Moving the amount from the Allowance into the Payer Account.
    Funding,
    /// Sent to the signer. Counts as spent from here on, whatever happens (ADR 0003).
    Signing,
    /// The Signed Payment is ready for the Agent to hand to the seller.
    Signed,
    /// The transfer into the Payer Account failed before anything reached the signer.
    FundingFailed,
    /// The signer didn't deliver a valid signature. Still counts as spent.
    SignatureUnavailable,
}

/// The x402 `exact` payment issued for a Spend Request.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignedPayment {
    /// Index of the Payer Account key that signs it (derivation path `x402/<index>`).
    pub key_index: u32,
    pub public_key: String,
    pub nonce: u64,
    pub max_block_height: u64,
    /// Base64 borsh `SignedDelegateAction`, the x402 `exact` NEAR payload. Set once Signed.
    pub signed_delegate_action: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendRequest {
    pub request_id: String,
    pub payee: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub max_timeout_blocks: u64,
    /// Block timestamp (ns) when it was submitted.
    pub requested_at_ns: u64,
    pub outcome: Outcome,
    pub status: Status,
    pub blocked_reason: Option<BlockedReason>,
    pub limit: Option<LimitDetail>,
    /// Hour bucket holding this request's Reservation against the Daily Cap; None once
    /// released (or if it never had one).
    pub reserved_hour: Option<u64>,
    pub payment: Option<SignedPayment>,
    /// False for a Blocked request beyond the per-hour storage budget (and for an
    /// IdempotencyConflict): its event is its only record and `get_request` won't find it.
    pub stored: bool,
}

impl SpendRequest {
    /// Same Payee, amount and memo: a retry, not a new request. The timeout may differ,
    /// because it is the seller's and only matters when the Signed Payment is issued.
    pub fn same_details(&self, payee: &AccountId, amount: U128, memo: &Option<String>) -> bool {
        &self.payee == payee && self.amount == amount && &self.memo == memo
    }
}

pub fn valid_request_id(id: &str) -> bool {
    (16..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
