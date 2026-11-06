//! Seam 1 for ticket #8: USDC deposits through transfer-and-notify, the budget view of where
//! the money is, and Withdraw limited to the USDC balance minus Held.

mod common;

use allowance::Allowance;
use allowance::funds::BudgetView;
use allowance::policy::Policy;
use allowance::request::{Outcome, SpendRequest, Status};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, NearToken, PromiseError, PromiseOrValue, testing_env};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const STRANGER: &str = "stranger.testnet";
const USDC_ID: &str = "usdc.testnet";
const OTHER_TOKEN: &str = "fake-usdc.testnet";
const USD: u128 = 1_000_000;
const ID: &str = "req_0000000000000001";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .account_balance(NearToken::from_near(7))
        .block_height(1_000)
        .block_timestamp(1_700_000_000_000_000_000);
    testing_env!(b.build());
}

/// Daily Cap $100, Auto Limit $5, Hard Ceiling $50: a $30 spend is Pending.
fn allowance() -> Allowance {
    ctx(OWNER);
    let policy = Policy {
        daily_cap: U128(100 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 10,
        max_timeout_blocks: 120,
    };
    let mut c = Allowance::new(
        acc(OWNER),
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap(),
        acc(USDC_ID),
        acc("v1.signer-prod.testnet"),
        1,
        policy,
        None,
    );
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    common::confirm();
    c.add_payee(acc(PAYEE));
    c
}

fn deposit(c: &mut Allowance, token: &str, amount: u128) -> u128 {
    ctx(token);
    match c.ft_on_transfer(acc(OWNER), U128(amount), String::new()) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer answers at once"),
    }
}

fn funded_allowance(amount: u128) -> Allowance {
    let mut c = allowance();
    deposit(&mut c, USDC_ID, amount);
    c
}

fn spend(c: &mut Allowance, id: &str, amount: u128) -> SpendRequest {
    ctx(ALLOWANCE);
    c.request_spend(id.into(), acc(PAYEE), U128(amount), None, 60)
}

/// The Owner withdraws, confirming with 1 yoctoNEAR as a wallet would.
fn withdraw(c: &mut Allowance, amount: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(OWNER))
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_height(1_000);
    testing_env!(b.build());
    let _ = c.withdraw(U128(amount));
}

fn budget(c: &Allowance) -> BudgetView {
    c.get_budget()
}

/// (USDC balance, Held, Withdrawable) in dollars.
fn money(c: &Allowance) -> (u128, u128, u128) {
    let b = budget(c);
    (b.usdc_balance.0 / USD, b.held.0 / USD, b.withdrawable.0 / USD)
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["standard"] == "allowance" && e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

/// The `ft_transfer` calls the last contract call scheduled: (token, args, deposit).
fn ft_transfers() -> Vec<(String, Value, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. }
                    if method_name == b"ft_transfer" =>
                {
                    Some((receiver.clone(), near_sdk::serde_json::from_slice(&args).unwrap(), attached_deposit))
                }
                _ => None,
            })
        })
        .collect()
}

// ---- deposits ----------------------------------------------------------------------

#[test]
fn a_deposit_of_the_configured_asset_is_credited_and_announced() {
    let mut c = allowance();
    assert_eq!(deposit(&mut c, USDC_ID, 40 * USD), 0, "all of it is kept");
    assert_eq!(events("deposit"), vec![json!({ "sender_id": OWNER, "amount": "40000000", "usdc_balance": "40000000" })]);
    assert_eq!(deposit(&mut c, USDC_ID, 2 * USD), 0);
    assert_eq!(money(&c), (42, 0, 42));
}

#[test]
fn any_other_token_is_refused_in_full_and_credits_nothing() {
    let mut c = funded_allowance(10 * USD);
    assert_eq!(deposit(&mut c, OTHER_TOKEN, 99 * USD), 99 * USD, "the whole amount is returned unused");
    assert!(events("deposit").is_empty());
    assert_eq!(money(&c), (10, 0, 10));
}

#[test]
fn the_budget_view_shows_the_near_balance_and_the_daily_cap_usage() {
    let mut c = funded_allowance(10 * USD);
    spend(&mut c, ID, 30 * USD);
    ctx(STRANGER);
    let b = budget(&c);
    assert_eq!(b.near_balance, NearToken::from_near(7));
    assert_eq!((b.cap.used_in_window, b.cap.available), (U128(30 * USD), U128(70 * USD)));
    let json = near_sdk::serde_json::to_value(&b).unwrap();
    for field in ["usdc_balance", "held", "withdrawable", "near_balance", "used_in_window", "available", "velocity_used"] {
        assert!(json.get(field).is_some(), "budget view JSON has {field} at the top level");
    }
}

// ---- Held ------------------------------------------------------------------------

#[test]
fn a_pending_spend_is_held_and_cannot_be_withdrawn() {
    let mut c = funded_allowance(100 * USD);
    let r = spend(&mut c, ID, 30 * USD);
    assert_eq!(r.outcome, Outcome::Pending);
    assert_eq!(money(&c), (100, 30, 70));
}

#[test]
fn pending_spends_can_hold_more_than_the_balance_and_nothing_is_withdrawable() {
    let mut c = funded_allowance(10 * USD);
    spend(&mut c, ID, 30 * USD);
    assert_eq!(money(&c), (10, 30, 0));
}

#[test]
fn an_approved_spend_leaves_the_balance_as_it_moves_to_the_payer_account_and_is_not_held() {
    let mut c = funded_allowance(100 * USD);
    let r = spend(&mut c, ID, 5 * USD);
    assert_eq!(r.status, Status::Funding);
    assert_eq!(money(&c), (95, 0, 95), "Funding: off the balance, not held as well");
    assert_eq!(ft_transfers()[0].1["amount"], "5000000");

    ctx(ALLOWANCE);
    let _ = c.on_payer_funded(ID.into(), Ok(()));
    assert_eq!(money(&c), (95, 0, 95), "behind a Signed Payment: neither on the balance nor held");
}

#[test]
fn failed_funding_puts_the_amount_back_on_the_balance() {
    let mut c = funded_allowance(100 * USD);
    spend(&mut c, ID, 5 * USD);
    ctx(ALLOWANCE);
    let _ = c.on_payer_funded(ID.into(), Err(PromiseError::Failed));
    assert_eq!(c.get_request(ID.into()).unwrap().status, Status::FundingFailed);
    assert_eq!(money(&c), (100, 0, 100));
}

#[test]
fn an_approved_spend_the_balance_cannot_cover_fails_funding_without_a_transfer() {
    let mut c = funded_allowance(4 * USD);
    spend(&mut c, "req_pending_000000001", 30 * USD);
    let r = spend(&mut c, ID, 5 * USD);
    assert_eq!((r.outcome, r.status, r.reserved_hour), (Outcome::Approved, Status::FundingFailed, None));
    assert_eq!(c.get_request(ID.into()), Some(r), "returned as stored");
    assert!(ft_transfers().is_empty(), "no transfer is attempted");
    assert_eq!(events("funding_failed")[0]["request_id"], ID);
    assert_eq!(money(&c), (4, 30, 0), "the Pending spend stays held");
    assert_eq!(budget(&c).cap.used_in_window, U128(30 * USD), "its Reservation is released");
}

#[test]
fn an_approved_spend_with_no_usdc_at_all_fails_funding() {
    let mut c = allowance();
    let r = spend(&mut c, ID, USD);
    assert_eq!(r.status, Status::FundingFailed);
    assert_eq!(money(&c), (0, 0, 0));
}

// ---- Withdraw -----------------------------------------------------------------------

#[test]
fn the_owner_withdraws_up_to_the_withdrawable_amount_to_themselves() {
    let mut c = funded_allowance(100 * USD);
    spend(&mut c, ID, 30 * USD);
    withdraw(&mut c, 70 * USD);
    assert_eq!(
        ft_transfers(),
        vec![(USDC_ID.into(), json!({ "receiver_id": OWNER, "amount": "70000000", "memo": null }), NearToken::from_yoctonear(1))]
    );
    assert_eq!(money(&c), (30, 30, 0));

    ctx(ALLOWANCE);
    c.on_withdrawn(acc(OWNER), U128(70 * USD), Ok(()));
    assert_eq!(events("withdraw"), vec![json!({ "receiver_id": OWNER, "amount": "70000000", "usdc_balance": "30000000" })]);
    assert_eq!(money(&c), (30, 30, 0));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_needs_the_owners_confirmation_not_just_a_function_call_key() {
    let mut c = funded_allowance(10 * USD);
    ctx(OWNER); // no deposit: what a web page's function-call key could send
    let _ = c.withdraw(U128(4 * USD));
}

#[test]
fn an_approved_spend_of_the_whole_balance_is_funded() {
    let mut c = funded_allowance(5 * USD);
    let r = spend(&mut c, ID, 5 * USD);
    assert_eq!(r.status, Status::Funding);
    assert_eq!(money(&c), (0, 0, 0));
}

#[test]
fn held_money_limits_withdraw_but_an_approved_spend_may_use_it() {
    // $10 in, $8 Pending: the Owner can only take $2, but a $5 auto-approved spend is paid
    // from the balance (Held is for Withdraw, per the spec).
    let mut c = funded_allowance(10 * USD);
    spend(&mut c, "req_pending_0000000001", 8 * USD);
    assert_eq!(money(&c), (10, 8, 2));
    assert_eq!(spend(&mut c, ID, 5 * USD).status, Status::Funding);
    assert_eq!(money(&c), (5, 8, 0));
}
#[test]
#[should_panic(expected = "amount exceeds Withdrawable: 70000001 requested, 70000000 withdrawable (100000000 balance, 30000000 held)")]
fn withdrawing_more_than_the_withdrawable_amount_fails_with_a_clear_error() {
    let mut c = funded_allowance(100 * USD);
    spend(&mut c, ID, 30 * USD);
    withdraw(&mut c, 70 * USD + 1);
}

#[test]
#[should_panic(expected = "amount exceeds Withdrawable")]
fn a_second_withdraw_cannot_take_money_already_on_its_way_out() {
    let mut c = funded_allowance(10 * USD);
    withdraw(&mut c, 6 * USD);
    withdraw(&mut c, 6 * USD);
}

#[test]
fn a_failed_withdraw_transfer_puts_the_amount_back() {
    let mut c = funded_allowance(10 * USD);
    withdraw(&mut c, 6 * USD);
    ctx(ALLOWANCE);
    c.on_withdrawn(acc(OWNER), U128(6 * USD), Err(PromiseError::Failed));
    assert!(events("withdraw").is_empty());
    assert_eq!(events("withdraw_failed"), vec![json!({ "receiver_id": OWNER, "amount": "6000000", "usdc_balance": "10000000" })]);
    assert_eq!(money(&c), (10, 0, 10));
}

#[test]
#[should_panic(expected = "only the Owner")]
fn only_the_owner_can_withdraw() {
    let mut c = funded_allowance(10 * USD);
    ctx(STRANGER);
    let _ = c.withdraw(U128(USD));
}

#[test]
#[should_panic(expected = "only the Owner")]
fn the_agent_cannot_withdraw() {
    let mut c = funded_allowance(10 * USD);
    ctx(ALLOWANCE);
    let _ = c.withdraw(U128(USD));
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn a_zero_withdraw_is_refused() {
    let mut c = funded_allowance(10 * USD);
    withdraw(&mut c, 0);
}

#[test]
fn get_asset_is_the_configured_usdc_contract() {
    let c = allowance();
    assert_eq!(c.get_asset(), acc(USDC_ID));
}
