//! Seam 1 for ticket #7: Pending spends wait for the Owner while holding a Reservation;
//! undecided ones Expire after 24 hours; approved ones Lapse unless the Agent picks up its
//! Signed Payment within an hour by re-submitting the Request ID.

mod common;

use allowance::Allowance;
use allowance::budget::HOUR_NS;
use allowance::policy::Policy;
use allowance::request::{BlockedReason, Outcome, SpendRequest, Status};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, PromiseError, testing_env};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const USD: u128 = 1_000_000;
const H: u64 = 480_000;
const MINUTE: u64 = 60_000_000_000;
const ID: &str = "req_pending_00000001";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn time(hour: u64, minutes: u64) -> u64 {
    (H + hour) * HOUR_NS + minutes * MINUTE
}

fn at(predecessor: &str, timestamp_ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(timestamp_ns)
        .block_height(10_000);
    testing_env!(b.build());
}

/// The demo Policy: Daily Cap $20, Auto Limit $5, Hard Ceiling $50, 10 per hour.
fn policy() -> Policy {
    Policy {
        daily_cap: U128(20 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 10,
        max_timeout_blocks: 120,
    }
}

fn allowance() -> Allowance {
    at(OWNER, time(0, 0));
    let mut c = Allowance::new(
        acc(OWNER),
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap(),
        acc("usdc.testnet"),
        acc("v1.signer-prod.testnet"),
        1,
        policy(),
        None,
    );
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    common::confirm();
    c.add_payee(acc(PAYEE));
    at("usdc.testnet", time(0, 0));
    let _ = c.ft_on_transfer(acc(OWNER), U128(1_000 * USD), String::new());
    c
}

fn submit(c: &mut Allowance, when: u64, id: &str, amount: u128) -> SpendRequest {
    at(ALLOWANCE, when);
    c.request_spend(id.into(), acc(PAYEE), U128(amount), Some("report".into()), 60)
}

/// A $15 Pending spend requested at hour 0.
fn pending() -> Allowance {
    let mut c = allowance();
    let r = submit(&mut c, time(0, 0), ID, 15 * USD);
    assert_eq!((r.outcome, r.status), (Outcome::Pending, Status::Pending));
    c
}

fn approve(c: &mut Allowance, when: u64) -> SpendRequest {
    at(OWNER, when);
    common::confirm();
    c.approve(ID.into())
}

fn used(c: &Allowance) -> u128 {
    c.get_budget().cap.used_in_window.0
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

fn transfers_scheduled() -> usize {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"ft_transfer"))
        .count()
}

// ---- Pending -----------------------------------------------------------------------

#[test]
fn a_pending_spend_holds_a_reservation_and_expires_24_hours_after_the_request() {
    let c = pending();
    assert_eq!(used(&c), 15 * USD);
    let r = c.get_request(ID.into()).unwrap();
    assert_eq!(r.expires_at_ns, Some(time(24, 0)));
    assert_eq!(c.list_pending(None, None).len(), 1);
}

#[test]
fn the_owner_approves_and_the_agent_has_an_hour_to_pick_up() {
    let mut c = pending();
    let r = approve(&mut c, time(2, 0));
    assert_eq!(r.status, Status::Approved);
    assert_eq!(r.pickup_deadline_ns, Some(time(3, 0)));
    assert_eq!(events("spend_approved")[0]["request_id"], ID);
    assert_eq!(transfers_scheduled(), 0, "approval alone pays nothing");
    assert_eq!(used(&c), 15 * USD, "still reserved");
}

#[test]
fn approval_moves_the_reservation_to_the_approval_hour() {
    let mut c = pending();
    let r = approve(&mut c, time(23, 50));
    assert_eq!(r.reserved_hour, Some(H + 23));
    // The request hour's bucket has left the window by hour 25, but the approval still holds.
    at(OWNER, time(25, 10));
    assert_eq!(used(&c), 15 * USD);
}

#[test]
fn the_owner_rejects_and_the_reservation_is_released() {
    let mut c = pending();
    at(OWNER, time(1, 0));
    common::confirm();
    let r = c.reject(ID.into());
    assert_eq!(r.status, Status::Rejected);
    assert_eq!(used(&c), 0);
    assert_eq!(events("spend_rejected")[0]["request_id"], ID);
    assert!(c.list_pending(None, None).is_empty());
}

#[test]
fn velocity_is_not_given_back_by_rejection() {
    let mut c = pending();
    at(OWNER, time(0, 1));
    common::confirm();
    c.reject(ID.into());
    assert_eq!(c.get_budget().cap.velocity_used, 1);
}

#[test]
fn an_undecided_spend_expires_and_releases_its_reservation_when_touched() {
    let mut c = pending();
    at(OWNER, time(24, 0));
    assert_eq!(c.get_request(ID.into()).unwrap().status, Status::Expired, "views show it at once");
    assert_eq!(c.expire(ID.into()), Status::Expired);
    assert_eq!(used(&c), 0);
    assert_eq!(events("spend_expired")[0]["request_id"], ID);
}

#[test]
fn just_before_24_hours_it_is_still_pending() {
    let mut c = pending();
    let r = approve(&mut c, time(24, 0) - 1);
    assert_eq!(r.status, Status::Approved);
}

// ---- Owner errors -----------------------------------------------------------------

#[test]
#[should_panic(expected = "request expired")]
fn approving_an_expired_spend_fails() {
    let mut c = pending();
    approve(&mut c, time(24, 0));
}

#[test]
#[should_panic(expected = "request already decided")]
fn approving_twice_fails() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    approve(&mut c, time(1, 1));
}

#[test]
#[should_panic(expected = "request already decided")]
fn rejecting_an_approved_spend_fails() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    at(OWNER, time(1, 1));
    common::confirm();
    c.reject(ID.into());
}

#[test]
#[should_panic(expected = "unknown request")]
fn approving_an_unknown_request_fails() {
    let mut c = pending();
    at(OWNER, time(1, 0));
    common::confirm();
    c.approve("req_nobody_asked_0001".into());
}

#[test]
#[should_panic(expected = "request was blocked")]
fn a_blocked_request_cannot_be_approved() {
    let mut c = allowance();
    at(ALLOWANCE, time(0, 0));
    c.request_spend(ID.into(), acc("attacker.testnet"), U128(USD), None, 60);
    approve(&mut c, time(0, 1));
}

#[test]
#[should_panic(expected = "only the Owner")]
fn only_the_owner_can_approve() {
    let mut c = pending();
    at(ALLOWANCE, time(1, 0));
    common::confirm();
    c.approve(ID.into());
}

#[test]
#[should_panic(expected = "request no longer qualifies: OverHardCeiling")]
fn approval_rechecks_a_lowered_hard_ceiling() {
    let mut c = pending();
    at(OWNER, time(1, 0));
    common::confirm();
    c.set_policy(Policy { hard_ceiling: U128(10 * USD), auto_limit: U128(5 * USD), ..policy() });
    common::confirm();
    c.approve(ID.into());
}

// ---- Pickup ------------------------------------------------------------------------

#[test]
fn re_submitting_after_approval_picks_up_the_signed_payment() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    at(ALLOWANCE, time(1, 30));
    let r = c.request_spend(ID.into(), acc(PAYEE), U128(15 * USD), Some("report".into()), 90);
    assert_eq!((r.outcome, r.status), (Outcome::Pending, Status::Funding));
    assert_eq!(r.max_timeout_blocks, 90, "the seller's timeout at Pickup is the one used");
    assert_eq!(transfers_scheduled(), 1);
    assert!(c.list_pending(None, None).is_empty());
    // A second re-submit while it's being paid schedules nothing more.
    let again = c.request_spend(ID.into(), acc(PAYEE), U128(15 * USD), Some("report".into()), 90);
    assert_eq!(again.status, Status::Funding);
}

#[test]
fn issuing_after_pickup_moves_the_reservation_to_the_issue_hour() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    submit(&mut c, time(1, 59), ID, 15 * USD);
    at(ALLOWANCE, time(2, 1));
    let _ = c.on_payer_funded(ID.into(), Ok(()));
    assert_eq!(c.get_request(ID.into()).unwrap().reserved_hour, Some(H + 2));
}

#[test]
fn re_submitting_while_still_pending_changes_nothing() {
    let mut c = pending();
    let r = submit(&mut c, time(3, 0), ID, 15 * USD);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(transfers_scheduled(), 0);
}

#[test]
fn an_approval_not_picked_up_within_an_hour_lapses_and_releases() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    let r = submit(&mut c, time(2, 0), ID, 15 * USD);
    assert_eq!(r.status, Status::Lapsed);
    assert_eq!(transfers_scheduled(), 0);
    assert_eq!(used(&c), 0);
    assert_eq!(events("spend_lapsed")[0]["request_id"], ID);
}

#[test]
fn pickup_rechecks_a_lowered_hard_ceiling_and_keeps_the_approval() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    at(OWNER, time(1, 10));
    common::confirm();
    c.set_policy(Policy { hard_ceiling: U128(10 * USD), ..policy() });
    let r = submit(&mut c, time(1, 20), ID, 15 * USD);
    assert_eq!((r.status, r.blocked_reason), (Status::Approved, Some(BlockedReason::OverHardCeiling)));
    assert_eq!(transfers_scheduled(), 0);
    assert_eq!(c.get_request(ID.into()).unwrap().blocked_reason, None, "the refusal isn't stored");
}

#[test]
fn pickup_clamps_a_timeout_beyond_the_policy_and_refuses_zero() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    at(ALLOWANCE, time(1, 5));
    let zero = c.request_spend(ID.into(), acc(PAYEE), U128(15 * USD), Some("report".into()), 0);
    assert_eq!(zero.blocked_reason, Some(BlockedReason::InvalidRequest));
    assert_eq!(transfers_scheduled(), 0);
    let r = c.request_spend(ID.into(), acc(PAYEE), U128(15 * USD), Some("report".into()), 10_000);
    assert_eq!((r.status, r.max_timeout_blocks), (Status::Funding, 120));
}

#[test]
fn held_funds_are_released_when_a_pending_spend_ends_without_paying() {
    let mut c = pending();
    assert_eq!(c.get_budget().held, U128(15 * USD));
    at(OWNER, time(1, 0));
    common::confirm();
    c.reject(ID.into());
    assert_eq!(c.get_budget().held, U128(0));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn approval_needs_the_owners_confirmation() {
    let mut c = pending();
    at(OWNER, time(1, 0));
    c.approve(ID.into());
}
#[test]
fn a_failed_transfer_after_pickup_releases_the_reservation() {
    let mut c = pending();
    approve(&mut c, time(1, 0));
    submit(&mut c, time(1, 5), ID, 15 * USD);
    at(ALLOWANCE, time(1, 6));
    let _ = c.on_payer_funded(ID.into(), Err(PromiseError::Failed));
    assert_eq!(used(&c), 0);
}

#[test]
fn the_pending_15_holds_the_cap_against_the_injected_split_in_the_demo() {
    // Demo step 4: with the $15 Pending, a 5 x $4 split gets one through.
    let mut c = pending();
    let outcomes: Vec<_> = (0..5)
        .map(|i| submit(&mut c, time(0, 10 + i), &format!("req_split_000000000{i}"), 4 * USD))
        .map(|r| (r.outcome, r.blocked_reason))
        .collect();
    assert_eq!(outcomes[0], (Outcome::Approved, None));
    for o in &outcomes[1..] {
        assert_eq!(*o, (Outcome::Blocked, Some(BlockedReason::DailyCapExceeded)));
    }
}
