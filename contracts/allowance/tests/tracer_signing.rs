//! Seam 1 (contract public methods) for the ticket #2 tracer: issuing one Signed Payment.

use allowance::{Allowance, PaymentStatus};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, testing_env};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

const ALLOWANCE: &str = "allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";

fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_height(1_000);
    b
}

fn contract() -> Allowance {
    testing_env!(ctx(OWNER).build());
    Allowance::new(
        acc(OWNER),
        acc("usdc.testnet"),
        acc("v1.signer-prod.testnet"),
        1,
    )
}

#[test]
#[should_panic(expected = "only the Agent")]
fn only_the_agent_can_request_a_signed_payment() {
    let mut c = contract();
    testing_env!(ctx(OWNER).build());
    let _ = c.tracer_sign("req_0000000000000001".into(), acc(PAYEE), U128(10_000), 60);
}

#[test]
fn agent_request_starts_funding_the_payer_account() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.tracer_sign("req_0000000000000001".into(), acc(PAYEE), U128(10_000), 60);
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::Funding);
    assert_eq!(p.amount, U128(10_000));
    assert_eq!(p.payee, acc(PAYEE));
}

#[test]
#[should_panic(expected = "request id already used")]
fn tracer_refuses_a_reused_request_id_until_idempotent_retries_land_in_ticket_4() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.tracer_sign("req_0000000000000001".into(), acc(PAYEE), U128(10_000), 60);
    let _ = c.tracer_sign("req_0000000000000001".into(), acc(PAYEE), U128(10_000), 60);
}

fn funded(c: &mut Allowance, id: &str, height: u64) {
    let mut b = ctx(ALLOWANCE);
    b.block_height(height);
    testing_env!(b.build());
    let _ = c.on_payer_funded(id.into(), Ok(()));
}

fn requested(c: &mut Allowance, id: &str) {
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.tracer_sign(id.into(), acc(PAYEE), U128(10_000), 60);
}

#[test]
fn funded_payment_is_built_with_the_previous_blocks_nonce_and_seller_timeout() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    funded(&mut c, "req_0000000000000001", 5_000);
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::Signing);
    assert_eq!(p.nonce, Some(4_999_000_000));
    assert_eq!(p.max_block_height, Some(5_060));
}

#[test]
fn two_payments_on_one_key_in_the_same_block_get_increasing_nonces() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    requested(&mut c, "req_0000000000000002");
    funded(&mut c, "req_0000000000000001", 5_000);
    funded(&mut c, "req_0000000000000002", 5_000);
    let a = c.get_signed_payment("req_0000000000000001".into()).unwrap().nonce.unwrap();
    let b = c.get_signed_payment("req_0000000000000002".into()).unwrap().nonce.unwrap();
    assert_eq!((a, b), (4_999_000_000, 4_999_000_001));
}

#[test]
fn failed_funding_is_not_spent_and_never_signed() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.on_payer_funded("req_0000000000000001".into(), Err(near_sdk::PromiseError::Failed));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::FundingFailed);
    assert_eq!(p.nonce, None);
}

#[test]
fn missing_signature_still_counts_as_spent() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    funded(&mut c, "req_0000000000000001", 5_000);
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.on_signed("req_0000000000000001".into(), Err(near_sdk::PromiseError::Failed));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::SignatureUnavailable);
    assert_eq!(p.signed_delegate_action, None);
}

// ---- signature handling -------------------------------------------------------------

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::serde_json::json;

fn payer_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[1u8; 32])
}

fn expected_delegate(public_key: [u8; 32]) -> allowance::delegate::FtTransferDelegate {
    allowance::delegate::FtTransferDelegate {
        sender_id: acc("pay.allowance.owner.testnet"),
        token_id: acc("usdc.testnet"),
        payee: acc(PAYEE),
        amount: 10_000,
        nonce: 4_999_000_000,
        max_block_height: 5_060,
        gas: 30_000_000_000_000,
        public_key,
    }
}

fn signed_contract() -> (Allowance, allowance::delegate::FtTransferDelegate) {
    let key = payer_signing_key();
    let pk = key.verifying_key().to_bytes();
    let mut c = contract();
    c.set_payer_keys_for_test(vec![pk]);
    requested(&mut c, "req_0000000000000001");
    funded(&mut c, "req_0000000000000001", 5_000);
    (c, expected_delegate(pk))
}

fn respond(c: &mut Allowance, response: near_sdk::serde_json::Value) {
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.on_signed("req_0000000000000001".into(), Ok(response));
}

#[test]
fn a_valid_signature_from_the_signer_becomes_the_x402_payload() {
    let (mut c, d) = signed_contract();
    let sig = payer_signing_key().sign(&d.signable_hash()).to_bytes();
    respond(&mut c, json!({"scheme": "Ed25519", "signature": sig.to_vec()}));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::Signed);
    assert_eq!(p.signed_delegate_action, Some(d.signed_delegate_action_base64(&sig)));
}

#[test]
fn a_signature_that_does_not_match_the_payment_is_not_stored() {
    let (mut c, _) = signed_contract();
    respond(&mut c, json!({"scheme": "Ed25519", "signature": vec![9u8; 64]}));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::SignatureUnavailable);
    assert_eq!(p.signed_delegate_action, None);
}

#[test]
fn an_unexpected_signer_response_ends_the_payment_instead_of_leaving_it_signing() {
    let (mut c, _) = signed_contract();
    respond(&mut c, json!({"scheme": "Secp256k1", "big_r": {"affine_point": "02ab"}, "s": {"scalar": "01"}}));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::SignatureUnavailable);
}

#[test]
fn the_signer_is_asked_to_sign_exactly_this_payments_hash_with_its_key_path() {
    let (_, d) = signed_contract();
    let sign_calls: Vec<_> = near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == acc("v1.signer-prod.testnet"))
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, attached_deposit, ..
            } if method_name.as_slice() == b"sign".as_slice() => Some((args, attached_deposit)),
            _ => None,
        })
        .collect();
    assert_eq!(sign_calls.len(), 1);
    let (args, deposit) = &sign_calls[0];
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(
        args,
        json!({"request": {
            "path": "x402/0",
            "payload_v2": {"Eddsa": hex::encode(d.signable_hash())},
            "domain_id": 1
        }})
    );
    assert_eq!(*deposit, near_sdk::NearToken::from_yoctonear(1));
}

// ---- request id validation ----------------------------------------------------------

#[test]
#[should_panic(expected = "request_id must be 16-128 characters of [A-Za-z0-9_-]")]
fn a_short_request_id_is_rejected() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "short");
}

#[test]
#[should_panic(expected = "request_id must be 16-128 characters of [A-Za-z0-9_-]")]
fn a_request_id_with_other_characters_is_rejected() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_00000000000000/1");
}

// ---- Payer Account creation ---------------------------------------------------------

#[test]
#[should_panic(expected = "payer account creation already in progress")]
fn payer_account_creation_cannot_overlap() {
    let mut c = contract();
    testing_env!(ctx(OWNER).build());
    let _ = c.create_payer_account(4);
    let _ = c.create_payer_account(8);
}

#[test]
fn payer_keys_are_only_recorded_once_the_account_exists() {
    let mut c = contract();
    testing_env!(ctx(OWNER).build());
    let _ = c.create_payer_account(1);
    let key = "ed25519:2SH6cXoPJ8nXiCu1Z3WYNLFNNj4ZYoaubiU1YwY3EcqX".to_string();
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.on_payer_created(vec![key.clone()], Err(near_sdk::PromiseError::Failed));
    assert!(c.payer_keys().is_empty());
    testing_env!(ctx(OWNER).build());
    let _ = c.create_payer_account(1);
    testing_env!(ctx(ALLOWANCE).build());
    let _ = c.on_payer_created(vec![key.clone()], Ok(()));
    assert_eq!(c.payer_keys(), vec![key]);
}
