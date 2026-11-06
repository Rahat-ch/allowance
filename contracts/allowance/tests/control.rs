//! Seam 1 for ticket #9: the Owner can Pause and unpause the Agent, Revoke it for good,
//! remove a Payee, and replace the Agent's key.

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
const OTHER: &str = "other.testnet";
const AGENT_KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const NEW_KEY: &str = "ed25519:2SH6cXoPJ8nXiCu1Z3WYNLFNNj4ZYoaubiU1YwY3EcqX";
const USD: u128 = 1_000_000;
const T0: u64 = 480_000 * HOUR_NS;
const MINUTE: u64 = 60_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(predecessor: &str, minutes: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(T0 + minutes * MINUTE)
        .block_height(10_000 + minutes);
    testing_env!(b.build());
}

fn owner(minutes: u64) {
    at(OWNER, minutes);
    common::confirm();
}

fn allowance() -> Allowance {
    at(OWNER, 0);
    let policy = Policy {
        daily_cap: U128(100 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 100,
        max_timeout_blocks: 120,
    };
    let mut c = Allowance::new(
        acc(OWNER),
        AGENT_KEY.parse().unwrap(),
        acc("usdc.testnet"),
        acc("v1.signer-prod.testnet"),
        1,
        policy,
        None,
    );
    c.set_payer_keys_for_test((1..=8).map(|i| [i; 32]).collect());
    common::confirm();
    c.add_payee(acc(PAYEE));
    common::confirm();
    c.add_payee(acc(OTHER));
    at("usdc.testnet", 0);
    let _ = c.ft_on_transfer(acc(OWNER), U128(1_000 * USD), String::new());
    c
}

fn spend(c: &mut Allowance, minutes: u64, id: &str, payee: &str, amount: u128) -> SpendRequest {
    at(ALLOWANCE, minutes);
    c.request_spend(id.into(), acc(payee), U128(amount), None, 60)
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

fn key_actions() -> Vec<MockAction> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(ALLOWANCE))
        .flat_map(|r| r.actions)
        .filter(|a| matches!(a, MockAction::DeleteKey { .. } | MockAction::AddKeyWithFunctionCall { .. }))
        .collect()
}

fn status(c: &Allowance, id: &str) -> Status {
    c.get_request(id.into()).unwrap().status
}

// ---- Pause -------------------------------------------------------------------------

#[test]
fn while_paused_new_requests_are_blocked_and_nothing_is_paid() {
    let mut c = allowance();
    at(OWNER, 1);
    c.pause(); // no confirmation needed to stop the Agent
    assert!(c.is_paused());
    assert_eq!(events("paused").len(), 1);
    let r = spend(&mut c, 2, "req_paused_000000001", PAYEE, USD);
    assert_eq!((r.outcome, r.blocked_reason), (Outcome::Blocked, Some(BlockedReason::Paused)));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn an_identical_retry_while_paused_still_returns_the_request() {
    let mut c = allowance();
    let first = spend(&mut c, 0, "req_before_pause_001", PAYEE, USD);
    at(OWNER, 1);
    c.pause();
    let retry = spend(&mut c, 2, "req_before_pause_001", PAYEE, USD);
    assert_eq!(retry.request_id, first.request_id);
    assert_eq!(retry.outcome, Outcome::Approved);
}

#[test]
fn the_owner_can_approve_while_paused_but_pickup_waits_for_unpause() {
    let mut c = allowance();
    spend(&mut c, 0, "req_pending_00000001", PAYEE, 15 * USD);
    at(OWNER, 1);
    c.pause();
    owner(2);
    assert_eq!(c.approve("req_pending_00000001".into()).status, Status::Approved);
    let refused = spend(&mut c, 3, "req_pending_00000001", PAYEE, 15 * USD);
    assert_eq!((refused.status, refused.blocked_reason), (Status::Approved, Some(BlockedReason::Paused)));
    owner(4);
    c.unpause();
    assert_eq!(events("unpaused").len(), 1);
    assert_eq!(spend(&mut c, 5, "req_pending_00000001", PAYEE, 15 * USD).status, Status::Funding);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unpausing_needs_the_owners_confirmation() {
    let mut c = allowance();
    at(OWNER, 1);
    c.pause();
    c.unpause();
}

#[test]
#[should_panic(expected = "only the Owner")]
fn only_the_owner_can_pause() {
    let mut c = allowance();
    at(PAYEE, 1);
    c.pause();
}

// ---- Revoke ------------------------------------------------------------------------

#[test]
fn revoke_deletes_the_agent_key_and_cancels_everything_not_signed() {
    let mut c = allowance();
    spend(&mut c, 0, "req_pending_00000001", PAYEE, 15 * USD);
    spend(&mut c, 0, "req_pending_00000002", PAYEE, 20 * USD);
    owner(1);
    c.approve("req_pending_00000002".into());
    spend(&mut c, 2, "req_signed_000000001", PAYEE, USD);
    at(ALLOWANCE, 3);
    let _ = c.on_payer_funded("req_signed_000000001".into(), Ok(()));
    let used_before = c.get_budget().cap.used_in_window.0;

    owner(4);
    let _ = c.revoke();

    assert!(c.is_revoked());
    assert_eq!(key_actions(), vec![MockAction::DeleteKey { receipt_index: 0, public_key: AGENT_KEY.parse().unwrap() }]);
    assert_eq!(status(&c, "req_pending_00000001"), Status::Cancelled);
    assert_eq!(status(&c, "req_pending_00000002"), Status::Cancelled);
    assert_eq!(status(&c, "req_signed_000000001"), Status::Signing, "already sent to the signer: stays");
    let b = c.get_budget();
    assert_eq!(b.cap.used_in_window.0, used_before - 35 * USD, "only the cancelled Reservations are released");
    assert_eq!(b.held, U128(0));
    assert!(c.list_pending(None, None).is_empty());
    assert_eq!(events("revoked")[0]["cancelled"], 2);
    assert_eq!(events("spend_cancelled").len(), 2);
}

#[test]
fn a_revoked_allowance_refuses_every_spend_even_if_a_key_came_back() {
    let mut c = allowance();
    owner(1);
    let _ = c.revoke();
    // The Agent's key is deleted; if one were re-added, calls would still arrive as the
    // Allowance itself, so the flag is what stops them.
    let r = spend(&mut c, 2, "req_after_revoke_01", PAYEE, USD);
    assert_eq!(r.blocked_reason, Some(BlockedReason::Revoked));
    assert!(key_actions().is_empty());
}

#[test]
#[should_panic(expected = "the Agent is revoked")]
fn revoke_is_permanent() {
    let mut c = allowance();
    owner(1);
    let _ = c.revoke();
    owner(2);
    c.unpause();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn revoke_needs_the_owners_confirmation() {
    let mut c = allowance();
    at(OWNER, 1);
    let _ = c.revoke();
}

#[test]
fn revoked_beats_paused_in_the_evaluation_order() {
    let mut c = allowance();
    at(OWNER, 1);
    c.pause();
    owner(2);
    let _ = c.revoke();
    assert_eq!(spend(&mut c, 3, "req_order_000000001", PAYEE, USD).blocked_reason, Some(BlockedReason::Revoked));
}

#[test]
fn paused_beats_validity_in_the_evaluation_order() {
    let mut c = allowance();
    at(OWNER, 1);
    c.pause();
    assert_eq!(spend(&mut c, 2, "req_order_000000002", "attacker.testnet", 0).blocked_reason, Some(BlockedReason::Paused));
}

// ---- removing a Payee --------------------------------------------------------------

#[test]
fn removing_a_payee_rejects_its_pending_and_cancels_its_approved_spends() {
    let mut c = allowance();
    spend(&mut c, 0, "req_payee_pending_01", PAYEE, 15 * USD);
    spend(&mut c, 0, "req_payee_approved_1", PAYEE, 20 * USD);
    spend(&mut c, 0, "req_other_pending_01", OTHER, 10 * USD);
    owner(1);
    c.approve("req_payee_approved_1".into());

    at(OWNER, 2);
    c.remove_payee(acc(PAYEE));

    assert_eq!(status(&c, "req_payee_pending_01"), Status::Rejected);
    assert_eq!(status(&c, "req_payee_approved_1"), Status::Cancelled);
    assert_eq!(status(&c, "req_other_pending_01"), Status::Pending, "other Payees are untouched");
    assert_eq!(c.get_allowlist(), vec![acc(OTHER)]);
    assert_eq!(c.get_budget().cap.used_in_window, U128(10 * USD));
    assert_eq!(c.get_budget().held, U128(10 * USD));
    assert_eq!(events("payee_removed")[0]["payee"], PAYEE);
    // And new spends to it are Blocked.
    assert_eq!(spend(&mut c, 3, "req_payee_after_rm1", PAYEE, USD).blocked_reason, Some(BlockedReason::UnknownPayee));
}

#[test]
fn removing_a_payee_that_is_not_listed_changes_nothing() {
    let mut c = allowance();
    at(OWNER, 1);
    c.remove_payee(acc("nobody.testnet"));
    assert!(events("payee_removed").is_empty());
}

// ---- the Agent's key ---------------------------------------------------------------

#[test]
fn the_owner_can_replace_the_agent_key_with_a_fresh_gas_allowance() {
    let mut c = allowance();
    owner(1);
    let _ = c.replace_agent_key(NEW_KEY.parse().unwrap(), None);
    let actions = key_actions();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0], MockAction::DeleteKey { receipt_index: 0, public_key: AGENT_KEY.parse().unwrap() });
    match &actions[1] {
        MockAction::AddKeyWithFunctionCall { public_key, method_names, allowance, .. } => {
            assert_eq!(public_key, &NEW_KEY.parse().unwrap());
            assert_eq!(method_names, &vec!["request_spend".to_string()]);
            assert!(allowance.is_some());
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(c.get_agent_key(), NEW_KEY.parse().unwrap());
    // Revoke then deletes the new key.
    owner(2);
    let _ = c.revoke();
    assert_eq!(key_actions(), vec![MockAction::DeleteKey { receipt_index: 0, public_key: NEW_KEY.parse().unwrap() }]);
}

#[test]
#[should_panic(expected = "the Agent is revoked")]
fn the_agent_key_cannot_be_replaced_after_revoke() {
    let mut c = allowance();
    owner(1);
    let _ = c.revoke();
    owner(2);
    let _ = c.replace_agent_key(NEW_KEY.parse().unwrap(), None);
}

#[test]
fn a_failed_transfer_after_revoke_cannot_be_retried_into_a_payment() {
    let mut c = allowance();
    spend(&mut c, 0, "req_in_flight_000001", PAYEE, USD);
    owner(1);
    let _ = c.revoke();
    at(ALLOWANCE, 2);
    let _ = c.on_payer_funded("req_in_flight_000001".into(), Err(PromiseError::Failed));
    assert_eq!(status(&c, "req_in_flight_000001"), Status::FundingFailed);
    let retry = spend(&mut c, 3, "req_in_flight_000001", PAYEE, USD);
    assert_eq!(retry.status, Status::FundingFailed);
}
