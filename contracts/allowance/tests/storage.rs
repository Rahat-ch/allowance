//! Seam 1 (contract public methods): the Agent can't drain the Allowance's NEAR through
//! storage. Blocked requests are stored only up to a per-hour budget; beyond it the event
//! is the only record.

use allowance::Allowance;
use allowance::budget::HOUR_NS;
use allowance::policy::Policy;
use allowance::request::{BlockedReason, Outcome, SpendRequest, Status};
use allowance::storage::BLOCKED_RECORDS_PER_HOUR;
use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, testing_env};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const ATTACKER: &str = "attacker.testnet";
const AGENT_KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const USD: u128 = 1_000_000;
/// The start of an hour bucket.
const T0: u64 = 472_222 * HOUR_NS;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, timestamp_ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_height(1_000)
        .block_timestamp(timestamp_ns);
    testing_env!(b.build());
}

fn allowance() -> Allowance {
    ctx(OWNER, T0);
    let mut c = Allowance::new(
        acc(OWNER),
        AGENT_KEY.parse().unwrap(),
        acc("usdc.testnet"),
        acc("v1.signer-prod.testnet"),
        1,
        Policy {
            daily_cap: U128(20 * USD),
            auto_limit: U128(5 * USD),
            hard_ceiling: U128(50 * USD),
            velocity_limit: 10,
            max_timeout_blocks: 120,
        },
        None,
    );
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    c.add_payee(acc(PAYEE));
    c
}

/// A maximal Request ID: 128 characters, unique per `n`.
fn id(n: usize) -> String {
    format!("{n:0>128}")
}

fn spend_at(c: &mut Allowance, t: u64, id: &str, payee: &str, amount: u128) -> SpendRequest {
    ctx(ALLOWANCE, t);
    c.request_spend(id.into(), acc(payee), U128(amount), Some("m".repeat(64)), 60)
}

/// Blocked requests to an unknown Payee, all in the hour starting at `t`.
fn flood(c: &mut Allowance, t: u64, from: usize, count: usize) -> Vec<SpendRequest> {
    (from..from + count).map(|n| spend_at(c, t + n as u64, &id(n), ATTACKER, USD)).collect()
}

fn spend_events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["event"] == "spend_request")
        .map(|e| e["data"][0].clone())
        .collect()
}

const BUDGET: usize = BLOCKED_RECORDS_PER_HOUR as usize;

#[test]
fn blocked_requests_are_stored_up_to_the_hourly_budget() {
    let mut c = allowance();
    let stored = flood(&mut c, T0, 0, BUDGET);
    for (n, r) in stored.iter().enumerate() {
        assert!(r.stored);
        assert_eq!(c.get_request(id(n)).as_ref(), Some(r));
    }
}

#[test]
fn a_blocked_request_beyond_the_budget_is_only_an_event() {
    let mut c = allowance();
    flood(&mut c, T0, 0, BUDGET);
    let r = spend_at(&mut c, T0 + 1_000, &id(BUDGET), ATTACKER, USD);

    assert_eq!((r.outcome, r.status, r.blocked_reason), (Outcome::Blocked, Status::Blocked, Some(BlockedReason::UnknownPayee)));
    assert!(!r.stored);
    assert_eq!(c.get_request(id(BUDGET)), None);
    let events = spend_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["request_id"], id(BUDGET));
    assert_eq!(events[0]["blocked_reason"], "UnknownPayee");
    assert_eq!(events[0]["stored"], false);
}

#[test]
fn a_stored_blocked_request_says_so_in_its_event() {
    let mut c = allowance();
    spend_at(&mut c, T0, &id(0), ATTACKER, USD);
    assert_eq!(spend_events()[0]["stored"], true);
}

#[test]
fn the_budget_starts_again_next_hour() {
    let mut c = allowance();
    flood(&mut c, T0 + HOUR_NS - 1_000, 0, BUDGET + 1);
    let next_hour = flood(&mut c, T0 + HOUR_NS, 100, BUDGET + 1);
    assert!(next_hour[..BUDGET].iter().all(|r| r.stored));
    assert!(!next_hour[BUDGET].stored);
}

#[test]
fn approved_and_pending_requests_are_stored_whatever_the_blocked_budget() {
    let mut c = allowance();
    flood(&mut c, T0, 0, BUDGET + 5);
    let approved = spend_at(&mut c, T0 + 100, "req_approved_000001", PAYEE, USD);
    let pending = spend_at(&mut c, T0 + 100, "req_pending_0000001", PAYEE, 6 * USD);
    assert_eq!((approved.outcome, pending.outcome), (Outcome::Approved, Outcome::Pending));
    assert!(approved.stored && pending.stored);
    assert_eq!(c.get_request("req_approved_000001".into()), Some(approved));
    assert_eq!(c.get_request("req_pending_0000001".into()), Some(pending));
}

#[test]
fn an_identical_retry_of_an_unstored_blocked_request_is_evaluated_afresh() {
    let mut c = allowance();
    flood(&mut c, T0, 0, BUDGET + 1);
    // The Owner allows the Payee; nothing recorded the earlier Blocked attempt, so the
    // retry is a new Spend Request (and nothing was ever paid for the old one).
    ctx(OWNER, T0 + 50);
    c.add_payee(acc(ATTACKER));
    let retry = spend_at(&mut c, T0 + 100, &id(BUDGET), ATTACKER, USD);
    assert_eq!(retry.outcome, Outcome::Approved);
    assert!(retry.stored);
}

#[test]
fn an_idempotency_conflict_is_not_stored_and_uses_none_of_the_budget() {
    let mut c = allowance();
    spend_at(&mut c, T0, &id(0), PAYEE, USD);
    for _ in 0..BUDGET + 5 {
        let r = spend_at(&mut c, T0 + 1, &id(0), PAYEE, 2 * USD);
        assert_eq!(r.blocked_reason, Some(BlockedReason::IdempotencyConflict));
        assert!(!r.stored);
    }
    assert_eq!(c.get_request(id(0)).unwrap().amount, U128(USD));
    assert!(flood(&mut c, T0 + 2, 1, BUDGET).iter().all(|r| r.stored));
}

#[test]
fn a_flood_of_blocked_requests_stores_only_the_budget() {
    // Storage bytes are measured in the sandbox test (packages/sandbox/test/storage.test.ts):
    // unit tests don't see the contract's real writes.
    let mut c = allowance();
    let mut events = 0;
    for n in 0..1_000 {
        flood(&mut c, T0, n, 1);
        events += spend_events().iter().filter(|e| e["request_id"] == id(n)).count();
    }
    assert_eq!(events, 1_000, "every request still emits its event");
    let stored = (0..1_000).filter(|&n| c.get_request(id(n)).is_some()).count();
    assert_eq!(stored, BUDGET);
}

#[test]
fn an_over_long_memo_is_blocked_and_never_stored_even_within_the_budget() {
    let mut c = allowance();
    ctx(ALLOWANCE, T0);
    let r = c.request_spend(id(0), acc(PAYEE), U128(USD), Some("x".repeat(10_000)), 60);
    assert_eq!(r.blocked_reason, Some(BlockedReason::InvalidRequest));
    assert!(r.stored);
    assert_eq!(c.get_request(id(0)).unwrap().memo, None);
}
