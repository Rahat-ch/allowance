//! Allowance: an on-chain budget an AI Agent can spend through x402 Signed Payments.
//!
//! The Agent submits Spend Requests; each gets an Outcome (Approved, Pending or Blocked)
//! under the Owner's Policy. Approved spends are paid as x402 `exact` Signed Payments: a
//! NEP-366 delegate from the Payer Account that this contract builds and has signed
//! through Chain Signatures itself (ADR 0003).

pub mod approvals;
pub mod budget;
pub mod control;
pub mod delegate;
pub mod events;
pub mod keys;
pub mod funds;
pub mod policy;
pub mod request;
pub mod storage;

use budget::{Budget, Shortfall, hour_of};
use delegate::FtTransferDelegate;
use keys::{KeyPool, KeyPoolStatus};
use funds::{BudgetView, Funds};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
    env, ext_contract, near, require,
};
use policy::Policy;
use storage::BlockedRecords;
use request::{
    BlockedReason, LimitDetail, MAX_MEMO_BYTES, Outcome, SignedPayment, SpendRequest, Status, valid_request_id,
};

/// Gas the inner `ft_transfer` of a Signed Payment may use (x402's default).
const FT_TRANSFER_GAS: u64 = 30_000_000_000_000;
/// NEAR kept in the Payer Account for its own storage (account + keys).
const PAYER_ACCOUNT_BALANCE: NearToken = NearToken::from_millinear(100);
/// NEP-145 storage deposit for one USDC account registration.
const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1_250);
/// Chain Signatures `sign` needs at least 15 TGas plus room for the yield (docs/notes).
const SIGN_GAS: Gas = Gas::from_tgas(50);
/// `on_signed` verifies the signature, encodes the payload and stores it.
const ON_SIGNED_GAS: Gas = Gas::from_tgas(30);
/// Largest signer response `on_signed` reads; a real one is ~300 bytes.
const SIGN_RESPONSE_MAX_BYTES: usize = 2_048;
/// Default NEAR the Agent's function-call key may spend on gas before the Owner replaces it.
pub(crate) const DEFAULT_AGENT_ALLOWANCE: NearToken = NearToken::from_near(1);
/// The only method the Agent's key may call.
pub const AGENT_METHOD: &str = "request_spend";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Allowance {
    owner_id: AccountId,
    asset_id: AccountId,
    signer_id: AccountId,
    domain_id: u64,
    policy: Policy,
    allowlist: IterableSet<AccountId>,
    paused: bool,
    revoked: bool,
    /// The Agent's function-call key on this account (deleted on Revoke).
    agent_key: PublicKey,
    /// The Payer Account's derived keys (paths `x402/<index>`) and their leases.
    keys: KeyPool,
    /// True while `create_payer_account` is waiting on its callbacks.
    payer_creating: bool,
    /// Daily Cap Reservations and Velocity counts by hour.
    budget: Budget,
    requests: LookupMap<String, SpendRequest>,
    /// Pending and approved-but-not-picked-up Request IDs.
    open_ids: IterableSet<String>,
    /// Stored Request IDs in submission order, for paging.
    request_ids: Vector<String>,
    /// How many Blocked requests were stored this hour (storage griefing protection).
    blocked_records: BlockedRecords,
    /// USDC ledger: balance and Held (see `funds`).
    funds: Funds,
}

// ---- external interfaces -------------------------------------------------------------

#[near(serializers = [json])]
pub enum SignPayload {
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: SignPayload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
pub struct SignResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[ext_contract(ext_signer)]
#[allow(dead_code)]
trait ChainSignatures {
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
    fn sign(&mut self, request: SignRequest) -> SignResponse;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: AccountId, registration_only: bool);
}

// ---- contract ------------------------------------------------------------------------

#[near]
impl Allowance {
    /// Sets up the Allowance and gives the Agent a function-call key on this account that
    /// can call only `request_spend`, with `agent_allowance` yoctoNEAR for gas (default 1 NEAR;
    /// a Spend Request attaches ~150 TGas).
    #[init]
    pub fn new(
        owner_id: AccountId,
        agent_public_key: PublicKey,
        asset_id: AccountId,
        signer_id: AccountId,
        domain_id: u64,
        policy: Policy,
        agent_allowance: Option<NearToken>,
    ) -> Self {
        policy.assert_valid();
        let agent_allowance = agent_allowance.unwrap_or(DEFAULT_AGENT_ALLOWANCE);
        Promise::new(env::current_account_id())
            .add_access_key_allowance(
                agent_public_key.clone(),
                near_sdk::Allowance::limited(agent_allowance).expect("agent_allowance must be positive"),
                env::current_account_id(),
                AGENT_METHOD,
            )
            .detach();
        Self {
            owner_id,
            asset_id,
            signer_id,
            domain_id,
            policy,
            allowlist: IterableSet::new(b"a"),
            paused: false,
            revoked: false,
            agent_key: agent_public_key.clone(),
            keys: KeyPool::default(),
            payer_creating: false,
            budget: Budget::new(b"b", b"c"),
            requests: LookupMap::new(b"r"),
            open_ids: IterableSet::new(b"o"),
            request_ids: Vector::new(b"i"),
            blocked_records: BlockedRecords::default(),
            funds: Funds::default(),
        }
    }

    // ---- views ----------------------------------------------------------------------

    /// The Owner's account, so a web page can tell whether the signed-in wallet controls this
    /// Allowance.
    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    /// The USDC (NEP-141) contract this Allowance is denominated in, fixed at initialization.
    /// Agents match it against an x402 offer's `asset` before asking to pay.
    pub fn get_asset(&self) -> AccountId {
        self.asset_id.clone()
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    /// Daily Cap and Velocity usage right now (Reservations included), the USDC balance,
    /// Held, Withdrawable and the NEAR balance.
    pub fn get_budget(&self) -> BudgetView {
        self.budget_view(self.budget.usage(now_hour(), self.policy.daily_cap.0, self.policy.velocity_limit))
    }

    /// The request as it is now (a due Expiry or Lapse shows straight away).
    pub fn get_request(&self, request_id: String) -> Option<SpendRequest> {
        let now = env::block_timestamp();
        self.requests
            .get(&request_id)
            .map(|r| SpendRequest { status: approvals::effective_status(r, now), ..r.clone() })
    }

    /// Stored Spend Requests, newest first, as they are now: `from_index` counts back from
    /// the newest (default 0), `limit` defaults to 20 and is capped at 100. Blocked requests
    /// beyond the per-hour storage budget aren't stored; only their events record them.
    pub fn list_requests(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SpendRequest> {
        let now = env::block_timestamp();
        let len = self.request_ids.len();
        let skip = from_index.unwrap_or(0).min(len);
        let take = limit.unwrap_or(20).min(100);
        (0..len - skip)
            .rev()
            .take(take as usize)
            .filter_map(|i| self.request_ids.get(i))
            .filter_map(|id| self.requests.get(id))
            .map(|r| SpendRequest { status: approvals::effective_status(r, now), ..r.clone() })
            .collect()
    }

    /// The Payer Account: a sub-account only this contract can sign for.
    pub fn payer_account_id(&self) -> AccountId {
        format!("pay.{}", env::current_account_id()).parse().unwrap()
    }

    pub fn payer_keys(&self) -> Vec<String> {
        self.keys.public_keys().map(ed25519_string).collect()
    }

    /// How many Payer Account keys a new Signed Payment could lease now, and when the next
    /// busy one frees.
    pub fn get_key_pool(&self) -> KeyPoolStatus {
        self.keys.status(env::block_height())
    }

    // ---- Owner ----------------------------------------------------------------------

    /// Replaces the Policy. It applies to new Spend Requests; approvals and Pickups
    /// re-check the current Hard Ceiling.
    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner_confirmed();
        policy.assert_valid();
        events::emit("policy_changed", json!({ "old": self.policy, "new": policy }));
        self.policy = policy;
    }

    #[payable]
    pub fn add_payee(&mut self, payee: AccountId) {
        self.assert_owner_confirmed();
        if self.allowlist.insert(payee.clone()) {
            events::emit("payee_added", json!({ "payee": payee }));
        }
    }

    /// Fetches `key_count` derived keys from the signer, then creates the Payer Account
    /// holding only those keys and registers it with the USDC contract.
    pub fn create_payer_account(&mut self, key_count: u32) -> Promise {
        self.assert_owner();
        require!(self.keys.is_empty(), "payer account already created");
        require!(!self.payer_creating, "payer account creation already in progress");
        require!((1..=32).contains(&key_count), "key_count must be 1..=32");
        self.payer_creating = true;
        let fetch = |i: u32| {
            ext_signer::ext(self.signer_id.clone())
                .with_static_gas(Gas::from_tgas(5))
                .derived_public_key(
                    derivation_path(i),
                    Some(env::current_account_id()),
                    Some(self.domain_id),
                )
        };
        let mut all = fetch(0);
        for i in 1..key_count {
            all = all.and(fetch(i));
        }
        all.then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(60))
                .on_payer_keys(key_count),
        )
    }

    // ---- Agent ----------------------------------------------------------------------

    /// The Agent asks to pay `amount` to `payee`. Returns the Spend Request with its
    /// Outcome. An Approved request's Signed Payment is issued asynchronously: poll
    /// `get_request` until its status is `Signed`.
    ///
    /// Re-submitting a Request ID with the same Payee, amount and memo returns the
    /// request as it is now, never a second payment. Different details are refused
    /// (Blocked, IdempotencyConflict) without storing anything.
    ///
    /// A malformed Request ID panics instead of being Blocked: there is no valid key to
    /// record it under, and nothing is stored or spent.
    ///
    /// Blocked requests are stored only up to a per-hour budget (see `storage`); beyond it
    /// the response and event say `stored: false`, and an identical retry is evaluated
    /// afresh, since nothing was recorded (nothing was paid either).
    ///
    /// A request that would be Approved while every Payer Account key is leased to an
    /// outstanding Signed Payment panics with "busy: ...". The panic reverts the call, so
    /// nothing is stored, reserved or counted: retry the same Request ID once a key frees
    /// (`get_key_pool`). `max_timeout_blocks` above the Policy maximum is clamped to it.
    pub fn request_spend(
        &mut self,
        request_id: String,
        payee: AccountId,
        amount: U128,
        memo: Option<String>,
        max_timeout_blocks: u64,
    ) -> SpendRequest {
        self.assert_agent();
        require!(
            valid_request_id(&request_id),
            "request_id must be 16-128 characters of [A-Za-z0-9_-]"
        );

        if let Some(existing) = self.requests.get(&request_id) {
            if existing.same_details(&payee, amount, &memo) {
                return self.resubmitted(&request_id, max_timeout_blocks);
            }
            // Its own event, so an indexer never mistakes the stored request for Blocked.
            events::emit(
                "idempotency_conflict",
                json!({ "request_id": request_id, "payee": payee, "amount": amount }),
            );
            return SpendRequest {
                outcome: Outcome::Blocked,
                status: Status::Blocked,
                blocked_reason: Some(BlockedReason::IdempotencyConflict),
                memo: None,
                ..self.new_request(request_id, payee, amount, None, max_timeout_blocks)
            };
        }

        let mut request = self.new_request(request_id, payee, amount, memo, max_timeout_blocks);
        match self.evaluate(&request) {
            Err((reason, limit)) => {
                request.outcome = Outcome::Blocked;
                request.status = Status::Blocked;
                request.blocked_reason = Some(reason);
                request.limit = limit;
                // Never store an over-long memo: it would let the Agent drain this account's
                // NEAR through storage.
                if request.memo.as_ref().is_some_and(|m| m.len() > MAX_MEMO_BYTES) {
                    request.memo = None;
                }
            }
            Ok(outcome) => {
                if outcome == Outcome::Approved {
                    // Before anything changes, so a busy refusal leaves no trace.
                    self.lease_signing_key(&request.request_id);
                }
                let hour = now_hour();
                self.budget.reserve(hour, request.amount.0);
                self.funds.hold(request.amount.0);
                request.reserved_hour = Some(hour);
                request.outcome = outcome;
                if outcome == Outcome::Pending {
                    request.status = Status::Pending;
                    request.expires_at_ns = Some(request.requested_at_ns + approvals::PENDING_TTL_NS);
                } else {
                    request.status = Status::Funding;
                }
            }
        }
        request.stored = request.outcome != Outcome::Blocked || self.blocked_records.admit(now_hour());
        emit_outcome(&request);
        if request.stored {
            self.store(&request);
        }
        if request.status == Status::Pending {
            self.open_ids.insert(request.request_id.clone());
        }
        if request.status == Status::Funding {
            self.issue_signed_payment(&request.request_id);
            // Funding can fail at once (not enough unheld USDC).
            return self.requests.get(&request.request_id).cloned().expect("stored");
        }
        request
    }

    // ---- callbacks ------------------------------------------------------------------

    /// Receives the derived keys and creates the Payer Account with only those keys.
    /// Keys are recorded only once the account exists (see `on_payer_created`).
    #[private]
    pub fn on_payer_keys(&mut self, key_count: u32) -> PromiseOrValue<()> {
        let mut keys = Vec::with_capacity(key_count as usize);
        for i in 0..key_count as u64 {
            let parsed = env::promise_result_checked(i, 200)
                .ok()
                .and_then(|raw| near_sdk::serde_json::from_slice::<String>(&raw).ok())
                .and_then(|s| try_parse_ed25519(&s));
            match parsed {
                Some(k) => keys.push(k),
                None => {
                    self.payer_creating = false;
                    env::log_str("derived_public_key failed; payer account not created");
                    return PromiseOrValue::Value(());
                }
            }
        }
        let mut create = Promise::new(self.payer_account_id())
            .create_account()
            .transfer(PAYER_ACCOUNT_BALANCE);
        for k in &keys {
            create = create.add_full_access_key(ed25519_public_key(k));
        }
        PromiseOrValue::Promise(
            create.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_payer_created(keys.iter().map(ed25519_string).collect()),
            ),
        )
    }

    /// Records the Payer Account's keys only if the account was really created, then
    /// registers it with the USDC contract.
    #[private]
    pub fn on_payer_created(
        &mut self,
        keys: Vec<String>,
        #[callback_result] created: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        self.payer_creating = false;
        if created.is_err() {
            env::log_str("payer account creation failed; keys not recorded");
            return PromiseOrValue::Value(());
        }
        self.keys = KeyPool::new(keys.iter().map(|k| try_parse_ed25519(k).expect("bad payer key")).collect());
        PromiseOrValue::Promise(
            ext_ft::ext(self.asset_id.clone())
                .with_attached_deposit(FT_STORAGE_DEPOSIT)
                .with_static_gas(Gas::from_tgas(10))
                .storage_deposit(self.payer_account_id(), true),
        )
    }

    /// The amount is in the Payer Account (or not). Builds the delegate and sends it to
    /// the signer; from here on the spend counts as spent.
    #[private]
    pub fn on_payer_funded(
        &mut self,
        request_id: String,
        #[callback_result] funded: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        let mut r = self.requests.get(&request_id).cloned().expect("unknown request");
        if funded.is_err() {
            self.funds.restore(r.amount.0);
            self.fail_funding(r);
            return PromiseOrValue::Value(());
        }
        // The leased key stays leased until this payment's max_block_height passes.
        let issued = self.keys.issue(&request_id, env::block_height(), r.max_timeout_blocks);
        let k = issued.key_index;
        let payment = SignedPayment {
            key_index: k,
            public_key: ed25519_string(&self.keys.public_key(k)),
            nonce: issued.nonce,
            max_block_height: issued.max_block_height,
            signed_delegate_action: None,
        };
        let hash = self.delegate_for(&r, &payment).signable_hash();
        // Issued now: the spend counts for a full window from this hour.
        let issue_hour = now_hour();
        if let Some(hour) = r.reserved_hour.replace(issue_hour) {
            self.budget.rebucket(hour, issue_hour, r.amount.0);
        }
        r.status = Status::Signing;
        r.payment = Some(payment);
        self.requests.insert(request_id.clone(), r);

        PromiseOrValue::Promise(
            ext_signer::ext(self.signer_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(SIGN_GAS)
                .sign(SignRequest {
                    path: derivation_path(k),
                    payload_v2: SignPayload::Eddsa(hex::encode(hash)),
                    domain_id: self.domain_id,
                })
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(ON_SIGNED_GAS)
                        .on_signed(request_id),
                ),
        )
    }

    #[private]
    pub fn on_signed(
        &mut self,
        request_id: String,
    ) {
        // Read the raw result and parse leniently: an unexpected response (including one that
        // isn't JSON) must end the payment, never revert this callback and leave it Signing.
        let signed = env::promise_result_checked(0, SIGN_RESPONSE_MAX_BYTES)
            .ok()
            .and_then(|raw| near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&raw).ok());
        let mut r = self.requests.get(&request_id).cloned().expect("unknown request");
        let mut payment = r.payment.clone().expect("payment built before signing");
        let d = self.delegate_for(&r, &payment);
        let public_key = self.keys.public_key(payment.key_index);
        let sig: Option<[u8; 64]> = signed
            .and_then(|v| near_sdk::serde_json::from_value::<SignResponse>(v).ok())
            .filter(|s| s.scheme == "Ed25519")
            .and_then(|s| s.signature.try_into().ok())
            .filter(|sig| env::ed25519_verify(sig, &d.signable_hash(), &public_key));
        match sig {
            Some(sig) => {
                payment.signed_delegate_action = Some(d.signed_delegate_action_base64(&sig));
                r.status = Status::Signed;
                events::emit(
                    "signed_payment_issued",
                    json!({
                        "request_id": r.request_id, "amount": r.amount, "payee": r.payee,
                        "nonce": payment.nonce, "max_block_height": payment.max_block_height,
                    }),
                );
            }
            None => {
                r.status = Status::SignatureUnavailable;
                events::emit(
                    "signature_unavailable",
                    json!({ "request_id": r.request_id, "amount": r.amount, "payee": r.payee }),
                );
            }
        }
        r.payment = Some(payment);
        self.requests.insert(request_id, r);
    }
}

impl Allowance {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the Owner");
    }

    /// The Owner, confirming with exactly 1 yoctoNEAR attached. A function-call key (such as
    /// the one a web page gets when the Owner signs in) can't attach a deposit, so these
    /// calls always need the Owner's full-access key or a wallet confirmation.
    pub(crate) fn assert_owner_confirmed(&self) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
    }

    /// The Agent's function-call key lives on this account, so the Agent calls as itself.
    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the Agent can submit Spend Requests"
        );
    }

    fn new_request(
        &self,
        request_id: String,
        payee: AccountId,
        amount: U128,
        memo: Option<String>,
        max_timeout_blocks: u64,
    ) -> SpendRequest {
        SpendRequest {
            request_id,
            payee,
            amount,
            memo,
            // The seller's timeout, clamped: a shorter validity is always acceptable to it.
            max_timeout_blocks: max_timeout_blocks.min(self.policy.max_timeout_blocks),
            requested_at_ns: env::block_timestamp(),
            outcome: Outcome::Blocked,
            status: Status::Blocked,
            blocked_reason: None,
            limit: None,
            reserved_hour: None,
            expires_at_ns: None,
            pickup_deadline_ns: None,
            payment: None,
            stored: false,
        }
    }

    /// The Policy, in the spec's order. Ok is Approved or Pending; Err is why it's Blocked,
    /// with how much is used and when a retry fits for the limits the Agent can wait out.
    fn evaluate(&self, r: &SpendRequest) -> Result<Outcome, (BlockedReason, Option<LimitDetail>)> {
        self.check(r).map_err(|reason| (reason, None))?;
        let hour = now_hour();
        self.budget
            .check_velocity(hour, self.policy.velocity_limit)
            .map_err(|s| (BlockedReason::VelocityExceeded, Some(limit_detail(s))))?;
        self.budget
            .check_cap(hour, r.amount.0, self.policy.daily_cap.0)
            .map_err(|s| (BlockedReason::DailyCapExceeded, Some(limit_detail(s))))?;
        if r.amount.0 <= self.policy.auto_limit.0 {
            Ok(Outcome::Approved)
        } else {
            Ok(Outcome::Pending)
        }
    }

    /// Everything before the rolling limits: Revoked, Paused, validity, Allowlist, Hard Ceiling.
    fn check(&self, r: &SpendRequest) -> Result<(), BlockedReason> {
        if self.revoked {
            return Err(BlockedReason::Revoked);
        }
        if self.paused {
            return Err(BlockedReason::Paused);
        }
        let memo_ok = r.memo.as_ref().is_none_or(|m| m.len() <= MAX_MEMO_BYTES);
        if r.amount.0 == 0 || !memo_ok || r.max_timeout_blocks == 0 || self.keys.is_empty() {
            return Err(BlockedReason::InvalidRequest);
        }
        if !self.allowlist.contains(&r.payee) {
            return Err(BlockedReason::UnknownPayee);
        }
        if r.amount.0 > self.policy.hard_ceiling.0 {
            return Err(BlockedReason::OverHardCeiling);
        }
        Ok(())
    }

    fn store(&mut self, r: &SpendRequest) {
        self.requests.insert(r.request_id.clone(), r.clone());
        self.request_ids.push(r.request_id.clone());
    }

    /// Leases a Payer Account key to `request_id` (or returns the one it holds), or refuses
    /// the whole call as busy. Every path that issues a Signed Payment (Approved now, or a
    /// Pickup) calls this before changing any state, so the panic leaves nothing behind.
    fn lease_signing_key(&mut self, request_id: &str) -> u32 {
        let height = env::block_height();
        match self.keys.lease(request_id, height) {
            Some(k) => k,
            None => match self.keys.status(height).next_free_height {
                Some(h) => env::panic_str(&format!("busy: all signing keys are in use, retry from block {h}")),
                None => env::panic_str("busy: all signing keys are in use, retry shortly"),
            },
        }
    }

    /// Moves the amount into the Payer Account, then (in `on_payer_funded`) builds and
    /// signs the delegate. The request must already hold a key (`lease_signing_key`) and
    /// be held (see `funds`); if the USDC can't cover it, it fails funding at once without
    /// a transfer.
    fn issue_signed_payment(&mut self, request_id: &str) {
        require!(self.keys.leased_to(request_id).is_some(), "no signing key leased for this request");
        let r = self.requests.get(request_id).cloned().expect("stored");
        if !self.funds.fund_payer(r.amount.0) {
            self.fail_funding(r);
            return;
        }
        ext_ft::ext(self.asset_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .ft_transfer(self.payer_account_id(), r.amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(100))
                    .on_payer_funded(request_id.to_string()),
            )
            .detach();
    }

    /// Nothing left the Allowance, so the Reservation is released (Velocity is not).
    /// Nothing left the Allowance: releases the Reservation (Velocity is not given back) and
    /// the signing key, nothing having been signed with it.
    fn fail_funding(&mut self, mut r: SpendRequest) {
        if let Some(hour) = r.reserved_hour.take() {
            self.budget.release(hour, r.amount.0);
        }
        self.keys.release(&r.request_id);
        r.status = Status::FundingFailed;
        events::emit("funding_failed", json!({ "request_id": r.request_id, "amount": r.amount, "payee": r.payee }));
        self.requests.insert(r.request_id.clone(), r);
    }

    fn delegate_for(&self, r: &SpendRequest, p: &SignedPayment) -> FtTransferDelegate {
        FtTransferDelegate {
            sender_id: self.payer_account_id(),
            token_id: self.asset_id.clone(),
            payee: r.payee.clone(),
            amount: r.amount.0,
            nonce: p.nonce,
            max_block_height: p.max_block_height,
            gas: FT_TRANSFER_GAS,
            public_key: self.keys.public_key(p.key_index),
        }
    }

    /// Test-only: seed Payer Account keys without the cross-contract derivation.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn set_payer_keys_for_test(&mut self, keys: Vec<[u8; 32]>) {
        self.keys = KeyPool::new(keys);
    }
}

pub(crate) fn now_hour() -> u64 {
    hour_of(env::block_timestamp())
}

fn limit_detail(s: Shortfall) -> LimitDetail {
    LimitDetail { used: U128(s.used), limit: U128(s.limit), retry_after_ns: s.retry_after_ns }
}

fn emit_outcome(r: &SpendRequest) {
    events::emit(
        "spend_request",
        json!({
            "request_id": r.request_id,
            "payee": r.payee,
            "amount": r.amount,
            "outcome": r.outcome,
            "blocked_reason": r.blocked_reason,
            "limit": r.limit,
            "stored": r.stored,
        }),
    );
}

/// Chain Signatures derivation path of Payer Account key `index`.
fn derivation_path(index: u32) -> String {
    format!("x402/{index}")
}

fn try_parse_ed25519(s: &str) -> Option<[u8; 32]> {
    let pk: PublicKey = s.parse().ok()?;
    let bytes = pk.as_bytes();
    if bytes.len() != 33 || bytes[0] != 0 {
        return None;
    }
    bytes[1..].try_into().ok()
}

fn ed25519_public_key(k: &[u8; 32]) -> PublicKey {
    ed25519_string(k).parse().unwrap()
}

fn ed25519_string(k: &[u8; 32]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k).into_string())
}
