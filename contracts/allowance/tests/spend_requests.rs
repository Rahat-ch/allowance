//! Seam 1 (contract public methods): Spend Requests get Approved or Blocked under the
//! Policy, Request IDs are idempotent, and Approved spends become Signed Payments.

use allowance::Allowance;
use allowance::policy::Policy;
use allowance::request::{BlockedReason, Outcome, SpendRequest, Status};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, PromiseError, PromiseResult, testing_env};

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const ATTACKER: &str = "attacker.testnet";
const USDC_ID: &str = "usdc.testnet";
const SIGNER_ID: &str = "v1.signer-prod.testnet";
const AGENT_KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
/// $1 in USDC base units.
const USD: u128 = 1_000_000;

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

/// The demo Policy: Daily Cap $20, Auto Limit $5, Hard Ceiling $50, 10 per hour.
fn demo_policy() -> Policy {
    Policy {
        daily_cap: U128(20 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 10,
        max_timeout_blocks: 120,
    }
}

fn payer_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[1u8; 32])
}

/// An Allowance with a Payer Account key and PAYEE on the Allowlist.
fn allowance() -> Allowance {
    ctx(OWNER, 1_000);
    let mut c = Allowance::new(
        acc(OWNER),
        AGENT_KEY.parse().unwrap(),
        acc(USDC_ID),
        acc(SIGNER_ID),
        1,
        demo_policy(),
        None,
    );
    c.set_payer_keys_for_test(vec![payer_signing_key().verifying_key().to_bytes()]);
    c.add_payee(acc(PAYEE));
    c
}

fn spend(c: &mut Allowance, id: &str, payee: &str, amount: u128) -> SpendRequest {
    ctx(ALLOWANCE, 1_000);
    c.request_spend(id.into(), acc(payee), U128(amount), Some("weather data".into()), 60)
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

/// Function calls the last contract call scheduled, as (receiver, method).
fn scheduled_calls() -> Vec<(String, String)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, .. } => {
                    Some((receiver.clone(), String::from_utf8(method_name).unwrap()))
                }
                _ => None,
            })
        })
        .collect()
}

/// JSON args of the scheduled call to `receiver`.`method`.
fn call_args(receiver: &str, method: &str) -> Value {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id.as_str() == receiver)
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == method.as_bytes() => {
                Some(near_sdk::serde_json::from_slice(&args).unwrap())
            }
            _ => None,
        })
        .expect("call scheduled")
}

const ID: &str = "req_0000000000000001";

// ---- setup -------------------------------------------------------------------------

#[test]
fn the_owner_sets_up_an_allowance_with_a_policy_the_agent_can_read() {
    let c = allowance();
    assert_eq!(c.get_policy(), demo_policy());
    assert_eq!(c.get_allowlist(), vec![acc(PAYEE)]);
}

#[test]
fn setup_gives_the_agent_a_key_that_can_only_call_request_spend() {
    let _ = allowance();
    let key_actions: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(ALLOWANCE))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::AddKeyWithFunctionCall { receiver_id, method_names, allowance, .. } => {
                Some((receiver_id, method_names, allowance))
            }
            _ => None,
        })
        .collect();
    assert_eq!(key_actions.len(), 1);
    let (receiver, methods, gas_allowance) = &key_actions[0];
    assert_eq!(receiver, &acc(ALLOWANCE));
    assert_eq!(methods, &vec!["request_spend".to_string()]);
    assert!(gas_allowance.is_some(), "the Agent's key has a limited gas allowance");
}

#[test]
#[should_panic(expected = "auto_limit must not exceed hard_ceiling")]
fn a_policy_whose_auto_limit_exceeds_its_hard_ceiling_is_refused() {
    ctx(OWNER, 1_000);
    let policy = Policy { auto_limit: U128(60 * USD), ..demo_policy() };
    Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, policy, None);
}

#[test]
#[should_panic(expected = "only the Owner")]
fn only_the_owner_can_add_a_payee() {
    let mut c = allowance();
    ctx(ALLOWANCE, 1_000);
    c.add_payee(acc(ATTACKER));
}

// ---- Outcomes ----------------------------------------------------------------------

#[test]
#[should_panic(expected = "only the Agent")]
fn only_the_agent_can_submit_a_spend_request() {
    let mut c = allowance();
    ctx(OWNER, 1_000);
    c.request_spend(ID.into(), acc(PAYEE), U128(USD), None, 60);
}

#[test]
fn a_spend_within_the_auto_limit_is_approved_and_starts_paying() {
    let mut c = allowance();
    let r = spend(&mut c, ID, PAYEE, USD / 2);
    assert_eq!((r.outcome, r.status), (Outcome::Approved, Status::Funding));
    assert_eq!(c.get_request(ID.into()), Some(r));
    assert_eq!(
        scheduled_calls(),
        vec![(USDC_ID.into(), "ft_transfer".into()), (ALLOWANCE.into(), "on_payer_funded".into())]
    );
    assert_eq!(
        call_args(USDC_ID, "ft_transfer"),
        json!({"receiver_id": "pay.allowance.owner.testnet", "amount": (USD / 2).to_string(), "memo": null}),
        "exactly the amount goes to the Payer Account"
    );
    assert_eq!(events("spend_request")[0]["outcome"], "Approved");
}

#[test]
fn a_spend_above_the_auto_limit_waits_for_the_owner() {
    let mut c = allowance();
    let r = spend(&mut c, ID, PAYEE, 15 * USD);
    assert_eq!((r.outcome, r.status), (Outcome::Pending, Status::Pending));
    assert_eq!(scheduled_calls(), vec![]);
    assert_eq!(events("spend_request")[0]["outcome"], "Pending");
}

fn assert_blocked(r: &SpendRequest, reason: BlockedReason) {
    assert_eq!((r.outcome, r.status, r.blocked_reason), (Outcome::Blocked, Status::Blocked, Some(reason)));
    assert_eq!(scheduled_calls(), vec![], "a Blocked request never moves money or reaches the signer");
    let e = &events("spend_request")[0];
    assert_eq!(e["outcome"], "Blocked");
    assert_eq!(e["blocked_reason"], json!(reason));
}

#[test]
fn a_payee_not_on_the_allowlist_is_blocked() {
    let mut c = allowance();
    let r = spend(&mut c, ID, ATTACKER, USD);
    assert_blocked(&r, BlockedReason::UnknownPayee);
    assert_eq!(c.get_request(ID.into()), Some(r), "Blocked requests are recorded");
}

#[test]
fn an_empty_allowlist_blocks_everything() {
    ctx(OWNER, 1_000);
    let mut c = Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, demo_policy(), None);
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    let r = spend(&mut c, ID, PAYEE, 1);
    assert_blocked(&r, BlockedReason::UnknownPayee);
}

#[test]
fn a_spend_over_the_hard_ceiling_is_blocked() {
    let mut c = allowance();
    let r = spend(&mut c, ID, PAYEE, 50 * USD + 1);
    assert_blocked(&r, BlockedReason::OverHardCeiling);
}

#[test]
fn exactly_the_hard_ceiling_is_allowed_with_approval() {
    ctx(OWNER, 1_000);
    let policy = Policy { daily_cap: U128(100 * USD), ..demo_policy() };
    let mut c = Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, policy, None);
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    c.add_payee(acc(PAYEE));
    assert_eq!(spend(&mut c, ID, PAYEE, 50 * USD).outcome, Outcome::Pending);
}

#[test]
fn exactly_the_auto_limit_is_approved() {
    let mut c = allowance();
    assert_eq!(spend(&mut c, ID, PAYEE, 5 * USD).outcome, Outcome::Approved);
}

#[test]
fn malformed_requests_are_blocked_as_invalid() {
    let mut c = allowance();
    ctx(ALLOWANCE, 1_000);
    let cases: Vec<(&str, u128, Option<String>, u64)> = vec![
        ("req_zero_amount_00001", 0, None, 60),
        ("req_long_memo_000001", USD, Some("x".repeat(65)), 60),
        ("req_zero_timeout_0001", USD, None, 0),
        ("req_long_timeout_0001", USD, None, 121),
    ];
    for (id, amount, memo, timeout) in cases {
        let r = c.request_spend(id.into(), acc(PAYEE), U128(amount), memo, timeout);
        assert_eq!(r.blocked_reason, Some(BlockedReason::InvalidRequest), "{id}");
    }
    assert_eq!(scheduled_calls(), vec![]);
}

#[test]
fn an_over_long_memo_is_never_stored() {
    let mut c = allowance();
    ctx(ALLOWANCE, 1_000);
    let r = c.request_spend(ID.into(), acc(PAYEE), U128(USD), Some("x".repeat(100_000)), 60);
    assert_eq!(r.blocked_reason, Some(BlockedReason::InvalidRequest));
    assert_eq!(c.get_request(ID.into()).unwrap().memo, None);
}

#[test]
fn a_64_byte_memo_is_fine() {
    let mut c = allowance();
    ctx(ALLOWANCE, 1_000);
    let r = c.request_spend(ID.into(), acc(PAYEE), U128(USD), Some("x".repeat(64)), 60);
    assert_eq!(r.outcome, Outcome::Approved);
}

#[test]
fn validity_is_checked_before_the_allowlist_and_the_allowlist_before_the_hard_ceiling() {
    let mut c = allowance();
    ctx(ALLOWANCE, 1_000);
    let invalid_and_unknown = c.request_spend("req_order_00000000001".into(), acc(ATTACKER), U128(0), None, 60);
    assert_eq!(invalid_and_unknown.blocked_reason, Some(BlockedReason::InvalidRequest));
    let unknown_and_too_big = c.request_spend("req_order_00000000002".into(), acc(ATTACKER), U128(100 * USD), None, 60);
    assert_eq!(unknown_and_too_big.blocked_reason, Some(BlockedReason::UnknownPayee));
}

#[test]
#[should_panic(expected = "request_id must be 16-128 characters of [A-Za-z0-9_-]")]
fn a_short_request_id_is_refused() {
    let mut c = allowance();
    spend(&mut c, "short", PAYEE, USD);
}

#[test]
#[should_panic(expected = "request_id must be 16-128 characters of [A-Za-z0-9_-]")]
fn a_request_id_with_other_characters_is_refused() {
    let mut c = allowance();
    spend(&mut c, "req_00000000000000/1", PAYEE, USD);
}

// ---- Request IDs -------------------------------------------------------------------

#[test]
fn an_identical_retry_returns_the_request_as_it_is_and_pays_nothing_more() {
    let mut c = allowance();
    let first = spend(&mut c, ID, PAYEE, USD);
    let retry = spend(&mut c, ID, PAYEE, USD);
    assert_eq!(retry, first);
    assert_eq!(scheduled_calls(), vec![], "the retry schedules no second transfer");
}

#[test]
fn an_identical_retry_of_a_blocked_request_stays_blocked() {
    let mut c = allowance();
    spend(&mut c, ID, ATTACKER, USD);
    let retry = spend(&mut c, ID, ATTACKER, USD);
    assert_eq!(retry.blocked_reason, Some(BlockedReason::UnknownPayee));
}

#[test]
fn a_retry_with_different_details_is_an_idempotency_conflict_and_changes_nothing() {
    let mut c = allowance();
    let first = spend(&mut c, ID, PAYEE, USD);
    for (payee, amount, memo) in [(PAYEE, 2 * USD, "weather data"), (ATTACKER, USD, "weather data"), (PAYEE, USD, "other")] {
        ctx(ALLOWANCE, 1_000);
        let r = c.request_spend(ID.into(), acc(payee), U128(amount), Some(memo.into()), 60);
        assert_eq!(r.blocked_reason, Some(BlockedReason::IdempotencyConflict));
        assert_eq!(scheduled_calls(), vec![]);
        assert_eq!(events("idempotency_conflict")[0]["request_id"], ID);
        assert!(events("spend_request").is_empty(), "the stored request's Outcome is not restated");
    }
    assert_eq!(c.get_request(ID.into()), Some(first), "the stored request is untouched");
}

// ---- issuing the Signed Payment ----------------------------------------------------

fn funded(c: &mut Allowance, height: u64) {
    ctx(ALLOWANCE, height);
    let _ = c.on_payer_funded(ID.into(), Ok(()));
}

fn approved_and_funded(height: u64) -> Allowance {
    let mut c = allowance();
    spend(&mut c, ID, PAYEE, USD);
    funded(&mut c, height);
    c
}

#[test]
fn a_funded_payment_gets_the_previous_blocks_nonce_and_the_sellers_timeout() {
    let c = approved_and_funded(5_000);
    let r = c.get_request(ID.into()).unwrap();
    assert_eq!(r.status, Status::Signing);
    let p = r.payment.unwrap();
    assert_eq!((p.nonce, p.max_block_height), (4_999_000_000, 5_060));
}

#[test]
fn two_payments_on_one_key_in_the_same_block_get_increasing_nonces() {
    let mut c = allowance();
    spend(&mut c, "req_0000000000000001", PAYEE, USD);
    spend(&mut c, "req_0000000000000002", PAYEE, USD);
    ctx(ALLOWANCE, 5_000);
    let _ = c.on_payer_funded("req_0000000000000001".into(), Ok(()));
    let _ = c.on_payer_funded("req_0000000000000002".into(), Ok(()));
    let nonce = |id: &str| c.get_request(id.into()).unwrap().payment.unwrap().nonce;
    assert_eq!((nonce("req_0000000000000001"), nonce("req_0000000000000002")), (4_999_000_000, 4_999_000_001));
}

#[test]
fn the_signer_is_asked_to_sign_exactly_this_payments_hash_with_its_key_path() {
    let c = approved_and_funded(5_000);
    let hash = expected_delegate(&c).signable_hash();
    let sign_calls: Vec<_> = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc(SIGNER_ID))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"sign" => {
                Some((args, attached_deposit))
            }
            _ => None,
        })
        .collect();
    assert_eq!(sign_calls.len(), 1);
    let (args, deposit) = &sign_calls[0];
    let args: Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(
        args,
        json!({"request": {"path": "x402/0", "payload_v2": {"Eddsa": hex::encode(hash)}, "domain_id": 1}})
    );
    assert_eq!(*deposit, near_sdk::NearToken::from_yoctonear(1));
}

#[test]
fn a_failed_transfer_into_the_payer_account_is_never_signed() {
    let mut c = allowance();
    spend(&mut c, ID, PAYEE, USD);
    ctx(ALLOWANCE, 5_000);
    let _ = c.on_payer_funded(ID.into(), Err(PromiseError::Failed));
    let r = c.get_request(ID.into()).unwrap();
    assert_eq!((r.status, r.payment), (Status::FundingFailed, None));
    assert_eq!(scheduled_calls(), vec![]);
}

fn expected_delegate(c: &Allowance) -> allowance::delegate::FtTransferDelegate {
    let p = c.get_request(ID.into()).unwrap().payment.unwrap();
    allowance::delegate::FtTransferDelegate {
        sender_id: acc("pay.allowance.owner.testnet"),
        token_id: acc(USDC_ID),
        payee: acc(PAYEE),
        amount: USD,
        nonce: p.nonce,
        max_block_height: p.max_block_height,
        gas: 30_000_000_000_000,
        public_key: payer_signing_key().verifying_key().to_bytes(),
    }
}

/// `on_signed` with the signer's result: a JSON answer, or a failed (timed out) call.
fn respond(c: &mut Allowance, response: Result<Value, PromiseError>) -> SpendRequest {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE)).predecessor_account_id(acc(ALLOWANCE)).block_height(5_002);
    let result = match response {
        Ok(v) => PromiseResult::Successful(near_sdk::serde_json::to_vec(&v).unwrap()),
        Err(_) => PromiseResult::Failed,
    };
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
    c.on_signed(ID.into());
    c.get_request(ID.into()).unwrap()
}

#[test]
fn a_signer_answer_that_is_not_json_ends_the_payment() {
    let mut c = approved_and_funded(5_000);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE)).predecessor_account_id(acc(ALLOWANCE));
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Successful(b"oops".to_vec())]);
    c.on_signed(ID.into());
    assert_eq!(c.get_request(ID.into()).unwrap().status, Status::SignatureUnavailable);
}

#[test]
fn a_valid_signature_becomes_the_x402_payload_and_an_identical_retry_returns_it() {
    let mut c = approved_and_funded(5_000);
    let d = expected_delegate(&c);
    let sig = payer_signing_key().sign(&d.signable_hash()).to_bytes();
    let r = respond(&mut c, Ok(json!({"scheme": "Ed25519", "signature": sig.to_vec()})));
    assert_eq!(r.status, Status::Signed);
    assert_eq!(r.payment.as_ref().unwrap().signed_delegate_action, Some(d.signed_delegate_action_base64(&sig)));
    assert_eq!(events("signed_payment_issued")[0]["request_id"], ID);
    assert_eq!(spend(&mut c, ID, PAYEE, USD), r);
}

#[test]
fn a_signature_that_does_not_match_the_payment_is_not_stored() {
    let mut c = approved_and_funded(5_000);
    let r = respond(&mut c, Ok(json!({"scheme": "Ed25519", "signature": vec![9u8; 64]})));
    assert_eq!(r.status, Status::SignatureUnavailable);
    assert_eq!(r.payment.unwrap().signed_delegate_action, None);
    assert_eq!(events("signature_unavailable")[0]["request_id"], ID);
}

#[test]
fn an_unexpected_signer_response_ends_the_payment_instead_of_leaving_it_signing() {
    let mut c = approved_and_funded(5_000);
    let r = respond(&mut c, Ok(json!({"scheme": "Secp256k1", "big_r": {"affine_point": "02ab"}})));
    assert_eq!(r.status, Status::SignatureUnavailable);
}

#[test]
fn a_missing_signature_still_counts_as_spent() {
    let mut c = approved_and_funded(5_000);
    let r = respond(&mut c, Err(PromiseError::Failed));
    assert_eq!(r.status, Status::SignatureUnavailable);
    assert!(r.payment.is_some(), "the payment was built and sent to the signer");
}

// ---- Payer Account creation --------------------------------------------------------

#[test]
#[should_panic(expected = "payer account creation already in progress")]
fn payer_account_creation_cannot_overlap() {
    ctx(OWNER, 1_000);
    let mut c = Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, demo_policy(), None);
    let _ = c.create_payer_account(4);
    let _ = c.create_payer_account(8);
}

#[test]
fn payer_keys_are_only_recorded_once_the_account_exists() {
    ctx(OWNER, 1_000);
    let mut c = Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, demo_policy(), None);
    let _ = c.create_payer_account(1);
    let key = "ed25519:2SH6cXoPJ8nXiCu1Z3WYNLFNNj4ZYoaubiU1YwY3EcqX".to_string();
    ctx(ALLOWANCE, 1_000);
    let _ = c.on_payer_created(vec![key.clone()], Err(PromiseError::Failed));
    assert!(c.payer_keys().is_empty());
    ctx(OWNER, 1_000);
    let _ = c.create_payer_account(1);
    ctx(ALLOWANCE, 1_000);
    let _ = c.on_payer_created(vec![key.clone()], Ok(()));
    assert_eq!(c.payer_keys(), vec![key]);
}

// ---- retries never pay twice -------------------------------------------------------

fn retry_schedules_nothing(c: &mut Allowance, expected: Status) {
    let before = c.get_request(ID.into()).unwrap();
    assert_eq!(before.status, expected);
    let retry = spend(c, ID, PAYEE, USD);
    assert_eq!(retry, before);
    assert_eq!(scheduled_calls(), vec![], "a retry in {expected:?} must not move money or sign again");
}

#[test]
fn a_retry_while_funding_or_signing_or_after_either_fails_never_pays_again() {
    let mut c = allowance();
    spend(&mut c, ID, PAYEE, USD);
    retry_schedules_nothing(&mut c, Status::Funding);

    funded(&mut c, 5_000);
    retry_schedules_nothing(&mut c, Status::Signing);

    respond(&mut c, Err(PromiseError::Failed));
    retry_schedules_nothing(&mut c, Status::SignatureUnavailable);

    let mut c = allowance();
    spend(&mut c, ID, PAYEE, USD);
    ctx(ALLOWANCE, 5_000);
    let _ = c.on_payer_funded(ID.into(), Err(PromiseError::Failed));
    retry_schedules_nothing(&mut c, Status::FundingFailed);
}

#[test]
#[should_panic(expected = "auto_limit must not exceed daily_cap")]
fn a_policy_whose_auto_limit_exceeds_its_daily_cap_is_refused() {
    ctx(OWNER, 1_000);
    let policy = Policy { daily_cap: U128(USD), ..demo_policy() };
    Allowance::new(acc(OWNER), AGENT_KEY.parse().unwrap(), acc(USDC_ID), acc(SIGNER_ID), 1, policy, None);
}
