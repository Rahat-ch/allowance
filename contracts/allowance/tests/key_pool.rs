//! Seam 1 for ticket #6: every outstanding Signed Payment leases a Payer Account key of its
//! own until its max_block_height passes, so concurrent payments never invalidate each
//! other; when no key is free the Agent gets a retryable "busy" refusal that changes nothing.

use allowance::Allowance;
use allowance::keys::{KeyPool, KeyPoolStatus};
use allowance::policy::Policy;
use allowance::request::{BlockedReason, Outcome, SpendRequest, Status};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, PromiseError, PromiseResult, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const USD: u128 = 1_000_000;
/// The Policy's longest Signed Payment validity in these tests.
const MAX_TIMEOUT: u64 = 120;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, height: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_height(height)
        .block_timestamp(1_700_000_000_000_000_000);
    testing_env!(b.build());
}

/// Daily Cap $20, Auto Limit $5, plenty of Velocity, and `key_count` Payer Account keys.
fn allowance(key_count: u8) -> Allowance {
    ctx(OWNER, 1_000);
    let policy = Policy {
        daily_cap: U128(20 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 100,
        max_timeout_blocks: MAX_TIMEOUT,
    };
    let mut c = Allowance::new(
        acc(OWNER),
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap(),
        acc("usdc.testnet"),
        acc("v1.signer-prod.testnet"),
        1,
        policy,
        None,
    );
    c.set_payer_keys_for_test((1..=key_count).map(|i| [i; 32]).collect());
    c.add_payee(acc(PAYEE));
    // Plenty of USDC, so funding the Payer Account never runs short.
    ctx("usdc.testnet", 1_000);
    let _ = c.ft_on_transfer(acc(OWNER), U128(1_000 * USD), String::new());
    c
}

fn id(n: u32) -> String {
    format!("req_key_pool_{n:08}")
}

fn spend_at(c: &mut Allowance, height: u64, n: u32, amount: u128, timeout: u64) -> SpendRequest {
    ctx(ALLOWANCE, height);
    c.request_spend(id(n), acc(PAYEE), U128(amount), None, timeout)
}

fn spend(c: &mut Allowance, height: u64, n: u32) -> SpendRequest {
    spend_at(c, height, n, USD, 60)
}

/// `request_spend` that is expected to be refused as busy; returns the panic message. (On
/// chain the panic reverts the call; here the tests check nothing was changed before it.)
fn busy(c: &mut Allowance, height: u64, n: u32) -> String {
    let err = catch_unwind(AssertUnwindSafe(|| spend(c, height, n))).expect_err("expected busy");
    err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap()
}

fn fund(c: &mut Allowance, height: u64, n: u32, ok: bool) -> SpendRequest {
    ctx(ALLOWANCE, height);
    let _ = c.on_payer_funded(id(n), if ok { Ok(()) } else { Err(PromiseError::Failed) });
    c.get_request(id(n)).unwrap()
}

/// The signer never answers (timed out): the request ends SignatureUnavailable.
fn signer_times_out(c: &mut Allowance, height: u64, n: u32) -> SpendRequest {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE)).predecessor_account_id(acc(ALLOWANCE)).block_height(height);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    c.on_signed(id(n));
    c.get_request(id(n)).unwrap()
}

fn key_of(r: &SpendRequest) -> u32 {
    r.payment.as_ref().expect("issued").key_index
}

fn pool(c: &Allowance, height: u64) -> KeyPoolStatus {
    ctx(OWNER, height);
    c.get_key_pool()
}

/// Derivation paths the last call asked the signer to sign with.
fn sign_paths() -> Vec<String> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"sign" => {
                let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
                Some(v["request"]["path"].as_str().unwrap().to_string())
            }
            _ => None,
        })
        .collect()
}

// ---- leasing -----------------------------------------------------------------------

#[test]
fn concurrent_signed_payments_each_get_their_own_key() {
    let mut c = allowance(3);
    for n in 0..3 {
        assert_eq!(spend(&mut c, 1_000, n).outcome, Outcome::Approved);
    }
    let mut paths = Vec::new();
    let mut keys = Vec::new();
    for n in 0..3 {
        keys.push(key_of(&fund(&mut c, 1_003, n, true)));
        paths.extend(sign_paths());
    }
    keys.sort();
    assert_eq!(keys, vec![0, 1, 2]);
    paths.sort();
    assert_eq!(paths, vec!["x402/0", "x402/1", "x402/2"]);
}

#[test]
fn a_key_is_leased_from_approval_not_just_from_signing() {
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0); // still Funding
    assert!(busy(&mut c, 1_001, 1).contains("busy: all signing keys are in use"));
}

#[test]
fn an_identical_retry_keeps_the_same_lease_and_takes_no_other_key() {
    let mut c = allowance(2);
    spend(&mut c, 1_000, 0);
    let retry = spend(&mut c, 1_001, 0);
    assert_eq!(retry.status, Status::Funding);
    assert_eq!(pool(&c, 1_001).free, 1);
}

#[test]
fn leasing_again_for_the_same_request_returns_its_key() {
    // The pool API an issuing path (Approved now, or a Pickup) calls: one lease per request.
    let mut pool = KeyPool::new(vec![[1; 32], [2; 32]]);
    assert_eq!(pool.lease("req_a", 1_000), Some(0));
    assert_eq!(pool.lease("req_a", 1_001), Some(0));
    assert_eq!(pool.lease("req_b", 1_001), Some(1));
    assert_eq!(pool.lease("req_c", 1_001), None);
    pool.release("req_a");
    assert_eq!(pool.lease("req_c", 1_001), Some(0));
}

#[test]
fn pending_and_blocked_spends_take_no_key() {
    let mut c = allowance(1);
    assert_eq!(spend_at(&mut c, 1_000, 0, 10 * USD, 60).outcome, Outcome::Pending);
    ctx(ALLOWANCE, 1_000);
    let blocked = c.request_spend(id(1), acc("attacker.testnet"), U128(USD), None, 60);
    assert_eq!(blocked.blocked_reason, Some(BlockedReason::UnknownPayee));
    assert_eq!(spend(&mut c, 1_000, 2).outcome, Outcome::Approved);
}

#[test]
fn a_request_that_breaks_the_policy_is_blocked_even_when_every_key_is_busy() {
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0);
    ctx(ALLOWANCE, 1_001);
    let r = c.request_spend(id(1), acc("attacker.testnet"), U128(USD), None, 60);
    assert_eq!(r.blocked_reason, Some(BlockedReason::UnknownPayee));
    assert_eq!(spend_at(&mut c, 1_001, 2, 30 * USD, 60).blocked_reason, Some(BlockedReason::DailyCapExceeded));
}

// ---- busy --------------------------------------------------------------------------

#[test]
fn when_no_key_is_free_the_spend_is_refused_as_busy_and_nothing_is_stored_or_reserved() {
    let mut c = allowance(2);
    spend(&mut c, 1_000, 0);
    spend(&mut c, 1_000, 1);
    ctx(OWNER, 1_001);
    let budget_before = c.get_budget();

    let message = busy(&mut c, 1_001, 2);
    assert!(message.contains("busy: all signing keys are in use, retry"), "{message}");
    assert!(get_logs().is_empty(), "no Outcome event");
    assert!(get_created_receipts().is_empty(), "no money moved");

    ctx(OWNER, 1_001);
    assert_eq!(c.get_request(id(2)), None, "nothing stored");
    assert_eq!(c.get_budget(), budget_before, "no Reservation and no Velocity used");
}

#[test]
fn a_busy_request_id_can_be_retried_and_approved_once_a_key_frees() {
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0);
    let first = fund(&mut c, 1_002, 0, true); // valid through 1_060 (60 blocks less the finality slack)
    assert_eq!(first.payment.as_ref().unwrap().max_block_height, 1_060);
    signer_times_out(&mut c, 1_010, 0);

    busy(&mut c, 1_030, 1);
    busy(&mut c, 1_060, 1); // the old payment can still execute at its max_block_height
    let retry = spend(&mut c, 1_061, 1);
    assert_eq!((retry.outcome, retry.status), (Outcome::Approved, Status::Funding));
    assert_eq!(key_of(&fund(&mut c, 1_065, 1, true)), 0);
}

#[test]
fn a_failed_transfer_into_the_payer_account_frees_its_key_at_once() {
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0);
    assert_eq!(fund(&mut c, 1_002, 0, false).status, Status::FundingFailed);
    assert_eq!(spend(&mut c, 1_002, 1).outcome, Outcome::Approved);
}

#[test]
fn a_payment_whose_signature_never_arrived_keeps_its_key_until_it_expires() {
    // A late signature can still be published and used until max_block_height.
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0);
    fund(&mut c, 1_002, 0, true);
    assert_eq!(signer_times_out(&mut c, 1_005, 0).status, Status::SignatureUnavailable);
    busy(&mut c, 1_050, 1);
    assert_eq!(spend(&mut c, 1_063, 1).outcome, Outcome::Approved);
}

#[test]
fn the_pool_view_shows_free_keys_and_when_the_next_one_frees() {
    let mut c = allowance(2);
    assert_eq!(pool(&c, 1_000), KeyPoolStatus { keys: 2, free: 2, next_free_height: None });
    spend(&mut c, 1_000, 0);
    spend(&mut c, 1_000, 1);
    assert_eq!(pool(&c, 1_001), KeyPoolStatus { keys: 2, free: 0, next_free_height: None }, "both still funding");
    fund(&mut c, 1_002, 0, true);
    fund(&mut c, 1_004, 1, true);
    assert_eq!(pool(&c, 1_010), KeyPoolStatus { keys: 2, free: 0, next_free_height: Some(1_061) });
    assert_eq!(pool(&c, 1_061), KeyPoolStatus { keys: 2, free: 1, next_free_height: None });
    assert_eq!(pool(&c, 1_065).free, 2);
}

// ---- nonce and max_block_height ----------------------------------------------------

#[test]
fn the_nonce_is_in_the_previous_blocks_range_and_validity_is_the_sellers_timeout() {
    let mut c = allowance(1);
    spend_at(&mut c, 5_000, 0, USD, 90);
    let p = fund(&mut c, 5_003, 0, true).payment.unwrap();
    // Above any key nonce from a few blocks back, below (height - 2) x 1e6, so the
    // facilitator's final height needn't have reached the issuing block yet.
    assert!(p.nonce >= 5_000 * 1_000_000 && p.nonce < 5_001 * 1_000_000, "{}", p.nonce);
    // Valid for the seller's timeout, less the same 2 blocks of slack.
    assert_eq!(p.max_block_height, 5_003 + 90 - 2);
}

#[test]
fn a_lease_whose_funding_never_completes_is_reclaimed() {
    // If the funding callback itself failed, the request would sit in Funding forever;
    // its key must not be lost with it (the account is locked, nothing else could free it).
    let mut pool = KeyPool::new(vec![[1; 32]]);
    assert_eq!(pool.lease("req_stuck", 1_000), Some(0));
    assert_eq!(pool.lease("req_next", 1_000 + allowance::keys::FUNDING_LEASE_BLOCKS), None);
    assert_eq!(pool.lease("req_next", 1_001 + allowance::keys::FUNDING_LEASE_BLOCKS), Some(0));
}

#[test]
fn a_tiny_timeout_still_gives_at_least_one_block() {
    let mut pool = KeyPool::new(vec![[1; 32]]);
    pool.lease("req_a", 1_000);
    assert_eq!(pool.issue("req_a", 1_000, 1).max_block_height, 1_001);
}

#[test]
fn a_reused_key_gets_a_higher_nonce_than_its_previous_payment() {
    let mut c = allowance(1);
    spend(&mut c, 1_000, 0);
    let first = fund(&mut c, 1_002, 0, true).payment.unwrap();
    spend(&mut c, 1_063, 1);
    let second = fund(&mut c, 1_064, 1, true).payment.unwrap();
    assert_eq!(first.key_index, second.key_index);
    assert!(second.nonce > first.nonce);
}

#[test]
fn a_keys_nonce_never_repeats_even_within_one_block() {
    // Leases keep payments on one key blocks apart, so the previous block's range already
    // rises; the per-key sequence is the guard if two ever land in the same block.
    let mut pool = KeyPool::new(vec![[1; 32]]);
    pool.lease("req_a", 1_000);
    let first = pool.issue("req_a", 1_000, 1);
    let again = pool.issue("req_a", 1_000, 1);
    assert_eq!((first.nonce, again.nonce), (997_000_000, 997_000_001));
}

#[test]
fn a_timeout_above_the_policy_maximum_is_clamped_to_it() {
    let mut c = allowance(1);
    let r = spend_at(&mut c, 1_000, 0, USD, 10_000);
    assert_eq!((r.outcome, r.max_timeout_blocks), (Outcome::Approved, MAX_TIMEOUT));
    let p = fund(&mut c, 1_002, 0, true).payment.unwrap();
    assert_eq!(p.max_block_height, 1_002 + MAX_TIMEOUT - 2);
}

#[test]
fn a_zero_timeout_is_invalid() {
    let mut c = allowance(1);
    assert_eq!(spend_at(&mut c, 1_000, 0, USD, 0).blocked_reason, Some(BlockedReason::InvalidRequest));
}
