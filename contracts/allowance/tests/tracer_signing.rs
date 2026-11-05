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
fn a_request_id_can_only_be_used_once() {
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
fn signature_from_the_signer_becomes_the_x402_payload() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    funded(&mut c, "req_0000000000000001", 5_000);
    testing_env!(ctx(ALLOWANCE).build());
    c.on_signed(
        "req_0000000000000001".into(),
        Ok(allowance::SignResponse { scheme: "Ed25519".into(), signature: vec![9u8; 64] }),
    );
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::Signed);
    let expected = allowance::delegate::FtTransferDelegate {
        sender_id: acc("pay.allowance.owner.testnet"),
        token_id: acc("usdc.testnet"),
        payee: acc(PAYEE),
        amount: 10_000,
        nonce: 4_999_000_000,
        max_block_height: 5_060,
        gas: 30_000_000_000_000,
        public_key: [7u8; 32],
    }
    .signed_delegate_action_base64(&[9u8; 64]);
    assert_eq!(p.signed_delegate_action, Some(expected));
}

#[test]
fn missing_signature_still_counts_as_spent() {
    let mut c = contract();
    c.set_payer_keys_for_test(vec![[7u8; 32]]);
    requested(&mut c, "req_0000000000000001");
    funded(&mut c, "req_0000000000000001", 5_000);
    testing_env!(ctx(ALLOWANCE).build());
    c.on_signed("req_0000000000000001".into(), Err(near_sdk::PromiseError::Failed));
    let p = c.get_signed_payment("req_0000000000000001".into()).unwrap();
    assert_eq!(p.status, PaymentStatus::SignatureUnavailable);
    assert_eq!(p.signed_delegate_action, None);
}
