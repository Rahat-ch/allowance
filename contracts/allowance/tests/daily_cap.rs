//! Seam 1 for ticket #5: the Daily Cap is exact over any rolling 24 hours because every
//! Approved or Pending spend holds a Reservation, and the Velocity Limit is never given back.

use allowance::Allowance;
use allowance::budget::HOUR_NS;
use allowance::policy::Policy;
use allowance::request::{BlockedReason, LimitDetail, Outcome, SpendRequest};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, PromiseError, testing_env};
use std::sync::atomic::{AtomicU32, Ordering};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const USD: u128 = 1_000_000;
/// An hour bucket well after the epoch; times below are offsets into it.
const H: u64 = 480_000;
const MINUTE: u64 = 60_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(predecessor: &str, timestamp_ns: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(timestamp_ns)
        .block_height(10_000);
    testing_env!(b.build());
}

/// Hour `hour` (relative to H) plus `minutes`.
fn time(hour: u64, minutes: u64) -> u64 {
    (H + hour) * HOUR_NS + minutes * MINUTE
}

/// Daily Cap $20, Auto Limit $5, Hard Ceiling $50, and the given Velocity Limit.
fn allowance(velocity_limit: u32) -> Allowance {
    at(OWNER, time(0, 0));
    let policy = Policy {
        daily_cap: U128(20 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit,
        max_timeout_blocks: 120,
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
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    c.add_payee(acc(PAYEE));
    c
}

static NEXT_ID: AtomicU32 = AtomicU32::new(0);

fn spend_at(c: &mut Allowance, timestamp_ns: u64, amount: u128) -> SpendRequest {
    at(ALLOWANCE, timestamp_ns);
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    c.request_spend(format!("req_{n:016}"), acc(PAYEE), U128(amount), None, 60)
}

fn blocked(r: &SpendRequest) -> (Option<BlockedReason>, Option<LimitDetail>) {
    (r.blocked_reason, r.limit.clone())
}

fn detail(used: u128, limit: u128, retry_after_ns: Option<u64>) -> Option<LimitDetail> {
    Some(LimitDetail { used: U128(used), limit: U128(limit), retry_after_ns })
}

// ---- Daily Cap ---------------------------------------------------------------------

#[test]
fn split_spends_stop_exactly_at_the_daily_cap() {
    let mut c = allowance(100);
    for minute in 0..4 {
        assert_eq!(spend_at(&mut c, time(0, minute), 5 * USD).outcome, Outcome::Approved);
    }
    let fifth = spend_at(&mut c, time(0, 10), 5 * USD);
    assert_eq!(
        blocked(&fifth),
        (Some(BlockedReason::DailyCapExceeded), detail(20 * USD, 20 * USD, Some(time(25, 0))))
    );
    // Even one base unit more is refused.
    assert_eq!(spend_at(&mut c, time(0, 11), 1).blocked_reason, Some(BlockedReason::DailyCapExceeded));
}

#[test]
fn many_small_requests_never_reserve_more_than_the_cap() {
    let mut c = allowance(1_000);
    let approved: u128 = (0..50)
        .map(|i| spend_at(&mut c, time(0, i % 60), 3 * USD))
        .filter(|r| r.outcome == Outcome::Approved)
        .map(|r| r.amount.0)
        .sum();
    assert_eq!(approved, 18 * USD, "six $3 spends fit in $20, the seventh would not");
    assert_eq!(c.get_budget().used_in_window, U128(18 * USD));
}

#[test]
fn a_pending_spend_holds_its_reservation() {
    let mut c = allowance(100);
    assert_eq!(spend_at(&mut c, time(0, 0), 15 * USD).outcome, Outcome::Pending);
    assert_eq!(spend_at(&mut c, time(0, 1), 5 * USD).outcome, Outcome::Approved);
    let over = spend_at(&mut c, time(0, 2), 1);
    assert_eq!(over.blocked_reason, Some(BlockedReason::DailyCapExceeded));
}

#[test]
fn a_spend_at_23_59_still_counts_at_00_01_so_nothing_doubles_up_across_midnight() {
    let mut c = allowance(100);
    // Hour 23 of "day one" and hour 0 of "day two" are just adjacent buckets.
    for _ in 0..4 {
        spend_at(&mut c, time(23, 59), 5 * USD);
    }
    let after_midnight = spend_at(&mut c, time(24, 1), 5 * USD);
    assert_eq!(after_midnight.blocked_reason, Some(BlockedReason::DailyCapExceeded));
    assert_eq!(after_midnight.limit.unwrap().retry_after_ns, Some(time(48, 0)));
}

#[test]
fn capacity_frees_24_to_25_hours_after_the_spend() {
    let mut c = allowance(100);
    for _ in 0..4 {
        spend_at(&mut c, time(0, 59), 5 * USD);
    }
    // A full 24 hours later it still counts, to the last instant of hour 24...
    assert_eq!(spend_at(&mut c, time(24, 59), 5 * USD).blocked_reason, Some(BlockedReason::DailyCapExceeded));
    assert_eq!(spend_at(&mut c, time(25, 0) - 1, 5 * USD).blocked_reason, Some(BlockedReason::DailyCapExceeded));
    // ...and frees when hour 25 starts.
    assert_eq!(spend_at(&mut c, time(25, 0), 5 * USD).outcome, Outcome::Approved);
}

#[test]
fn no_rolling_24_hours_ever_holds_more_than_the_cap() {
    // Spend the whole cap at 00:59:59; nothing more may be Approved until 24h have passed.
    let mut c = allowance(1_000);
    let start = time(0, 59) + 59_000_000_000;
    assert_eq!(spend_at(&mut c, start, 5 * USD).outcome, Outcome::Approved);
    for _ in 0..3 {
        spend_at(&mut c, start, 5 * USD);
    }
    let mut t = start;
    while t < start + 24 * HOUR_NS {
        assert_eq!(spend_at(&mut c, t, 1).blocked_reason, Some(BlockedReason::DailyCapExceeded), "at +{}s", (t - start) / 1_000_000_000);
        t += 10 * MINUTE;
    }
}
#[test]
fn retry_after_points_at_when_enough_capacity_frees() {
    let mut c = allowance(100);
    spend_at(&mut c, time(0, 0), 5 * USD);
    spend_at(&mut c, time(3, 0), 5 * USD);
    spend_at(&mut c, time(5, 0), 5 * USD);
    spend_at(&mut c, time(5, 1), 4 * USD);
    // $19 used. $6 more fits once the hour-0 spend leaves the window: $14 + $6 = $20.
    let r = spend_at(&mut c, time(6, 0), 6 * USD);
    assert_eq!(blocked(&r), (Some(BlockedReason::DailyCapExceeded), detail(19 * USD, 20 * USD, Some(time(25, 0)))));
    // $11 more also needs the hour-3 spend gone: $9 + $11 = $20.
    let big = spend_at(&mut c, time(6, 1), 11 * USD);
    assert_eq!(big.limit.unwrap().retry_after_ns, Some(time(28, 0)));
}

#[test]
fn a_spend_bigger_than_the_cap_can_never_fit() {
    let mut c = allowance(100);
    let r = spend_at(&mut c, time(0, 0), 21 * USD);
    assert_eq!(blocked(&r), (Some(BlockedReason::DailyCapExceeded), detail(0, 20 * USD, None)));
}

#[test]
fn failed_funding_releases_the_reservation() {
    let mut c = allowance(100);
    let r = spend_at(&mut c, time(0, 0), 5 * USD);
    at(ALLOWANCE, time(0, 1));
    let _ = c.on_payer_funded(r.request_id.clone(), Err(PromiseError::Failed));
    assert_eq!(c.get_budget().used_in_window, U128(0));
    assert_eq!(c.get_request(r.request_id).unwrap().reserved_hour, None);
}

#[test]
fn failed_funding_releases_only_that_spends_share_of_its_bucket() {
    let mut c = allowance(100);
    let a = spend_at(&mut c, time(0, 0), 5 * USD);
    spend_at(&mut c, time(0, 1), 3 * USD);
    at(ALLOWANCE, time(0, 2));
    let _ = c.on_payer_funded(a.request_id, Err(PromiseError::Failed));
    assert_eq!(c.get_budget().used_in_window, U128(3 * USD));
}

#[test]
fn issuing_moves_the_reservation_to_the_issue_hour() {
    let mut c = allowance(100);
    let r = spend_at(&mut c, time(0, 0), 20 * USD);
    // Funded and sent to the signer two hours later (e.g. after a Pickup).
    at(ALLOWANCE, time(2, 0));
    let _ = c.on_payer_funded(r.request_id.clone(), Ok(()));
    assert_eq!(c.get_request(r.request_id).unwrap().reserved_hour, Some(H + 2));
    assert_eq!(c.get_budget().used_in_window, U128(20 * USD), "moved, not counted twice");
    // So it is still held when the request hour's bucket would have left the window.
    assert_eq!(spend_at(&mut c, time(25, 30), 1).blocked_reason, Some(BlockedReason::DailyCapExceeded));
    assert_eq!(spend_at(&mut c, time(27, 0), 1).outcome, Outcome::Approved);
}

#[test]
fn the_budget_view_shows_usage_reservations_and_when_capacity_frees() {
    let mut c = allowance(10);
    spend_at(&mut c, time(0, 0), 15 * USD); // Pending
    spend_at(&mut c, time(1, 0), 2 * USD); // Approved
    at(OWNER, time(1, 30));
    let b = c.get_budget();
    assert_eq!((b.used_in_window, b.daily_cap, b.available), (U128(17 * USD), U128(20 * USD), U128(3 * USD)));
    assert_eq!(b.next_release_ns, Some(time(25, 0)));
    assert_eq!((b.velocity_used, b.velocity_limit), (2, 10));
}

// ---- Velocity ----------------------------------------------------------------------

#[test]
fn velocity_counts_approved_and_pending_spends_per_rolling_hour() {
    let mut c = allowance(3);
    spend_at(&mut c, time(0, 0), USD);
    spend_at(&mut c, time(0, 1), 10 * USD); // Pending counts too
    spend_at(&mut c, time(0, 2), USD);
    let fourth = spend_at(&mut c, time(0, 3), USD);
    assert_eq!(blocked(&fourth), (Some(BlockedReason::VelocityExceeded), detail(3, 3, Some(time(2, 0)))));
    // The previous hour still counts during the next one.
    assert_eq!(spend_at(&mut c, time(1, 59), USD).blocked_reason, Some(BlockedReason::VelocityExceeded));
    assert_eq!(spend_at(&mut c, time(2, 0), USD).outcome, Outcome::Approved);
}

#[test]
fn velocity_frees_next_hour_when_this_hours_spends_are_under_the_limit() {
    let mut c = allowance(3);
    spend_at(&mut c, time(0, 0), USD);
    spend_at(&mut c, time(0, 1), USD);
    spend_at(&mut c, time(1, 0), USD);
    let r = spend_at(&mut c, time(1, 5), USD);
    assert_eq!(r.limit.unwrap().retry_after_ns, Some(time(2, 0)));
}

#[test]
fn blocked_requests_use_neither_velocity_nor_cap() {
    let mut c = allowance(2);
    at(ALLOWANCE, time(0, 0));
    for i in 0..5 {
        c.request_spend(format!("req_unknown_payee_{i:03}"), acc("attacker.testnet"), U128(USD), None, 60);
    }
    let b = c.get_budget();
    assert_eq!((b.used_in_window, b.velocity_used), (U128(0), 0));
}

#[test]
fn velocity_is_not_given_back_when_funding_fails() {
    let mut c = allowance(1);
    let r = spend_at(&mut c, time(0, 0), USD);
    at(ALLOWANCE, time(0, 1));
    let _ = c.on_payer_funded(r.request_id, Err(PromiseError::Failed));
    assert_eq!(spend_at(&mut c, time(0, 2), USD).blocked_reason, Some(BlockedReason::VelocityExceeded));
}

#[test]
fn velocity_is_checked_before_the_daily_cap() {
    let mut c = allowance(1);
    spend_at(&mut c, time(0, 0), 20 * USD);
    assert_eq!(spend_at(&mut c, time(0, 1), USD).blocked_reason, Some(BlockedReason::VelocityExceeded));
}
