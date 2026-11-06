//! Seam 1 for ticket #21: the Owner sweeps USDC that uncollected Signed Payments left in
//! the Payer Account back into the Allowance. A sweep leases a key with no unexpired Signed
//! Payment, is capped by the Payer Account's balance minus unexpired payments, is signed
//! like a Signed Payment, and its returned USDC is credited and Withdrawable; the Daily Cap
//! is untouched.

mod common;

use allowance::Allowance;
use allowance::delegate::FtTransferCallDelegate;
use allowance::funds::BudgetView;
use allowance::keys::{KeyPoolStatus, SETTLEMENT_SLACK_BLOCKS};
use allowance::policy::Policy;
use allowance::request::Status;
use allowance::sweep::{Sweep, SweepStatus};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, NearToken, PromiseError, PromiseResult, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};

const ALLOWANCE: &str = "allowance.owner.testnet";
const PAYER: &str = "pay.allowance.owner.testnet";
const OWNER: &str = "owner.testnet";
const PAYEE: &str = "payee.testnet";
const USDC_ID: &str = "usdc.testnet";
const USD: u128 = 1_000_000;
const SWEEP_GAS: u64 = 60_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, height: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .account_balance(NearToken::from_near(7))
        .block_height(height)
        .block_timestamp(1_700_000_000_000_000_000);
    testing_env!(b.build());
}

/// A callback running at `height` with one promise result.
fn callback_ctx(height: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ALLOWANCE))
        .predecessor_account_id(acc(ALLOWANCE))
        .account_balance(NearToken::from_near(7))
        .block_height(height)
        .block_timestamp(1_700_000_000_000_000_000);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

/// Payer Account key `i` (derivation path `x402/<i>`), as the MPC network would hold it.
fn payer_key(i: u32) -> SigningKey {
    SigningKey::from_bytes(&[i as u8 + 1; 32])
}

/// Daily Cap $20, Auto Limit $5, `keys` Payer Account keys and $100 deposited.
fn allowance(keys: u32) -> Allowance {
    ctx(OWNER, 1_000);
    let policy = Policy {
        daily_cap: U128(20 * USD),
        auto_limit: U128(5 * USD),
        hard_ceiling: U128(50 * USD),
        velocity_limit: 100,
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
    c.set_payer_keys_for_test((0..keys).map(|i| payer_key(i).verifying_key().to_bytes()).collect());
    common::confirm();
    c.add_payee(acc(PAYEE));
    deposit(&mut c, OWNER, 100 * USD, "");
    c
}

fn deposit(c: &mut Allowance, sender: &str, amount: u128, msg: &str) {
    deposit_at(c, 1_000, sender, amount, msg);
}

/// USDC arriving through `ft_on_transfer` at `height` (a relayed sweep, or any deposit).
fn deposit_at(c: &mut Allowance, height: u64, sender: &str, amount: u128, msg: &str) {
    ctx(USDC_ID, height);
    let _ = c.ft_on_transfer(acc(sender), U128(amount), msg.into());
}

fn rid(n: u32) -> String {
    format!("req_sweep_test_{n:04}")
}

/// An Approved spend of `amount`, funded into the Payer Account at `height` with a
/// 60-block validity (so it expires after `height + 58`), never collected.
fn issue_payment(c: &mut Allowance, n: u32, amount: u128, height: u64) -> u32 {
    ctx(ALLOWANCE, height);
    let r = c.request_spend(rid(n), acc(PAYEE), U128(amount), None, 60);
    assert_eq!(r.status, Status::Funding);
    ctx(ALLOWANCE, height);
    let _ = c.on_payer_funded(rid(n), Ok::<(), PromiseError>(()));
    let r = c.get_request(rid(n)).unwrap();
    assert_eq!(r.payment.as_ref().unwrap().max_block_height, height + 58);
    r.payment.unwrap().key_index
}

/// The Owner asks for a sweep, confirming with 1 yoctoNEAR.
fn sweep_as(c: &mut Allowance, who: &str, height: u64, amount: Option<u128>, confirm: bool) -> Result<u64, String> {
    ctx(who, height);
    if confirm {
        common::confirm();
    }
    catch_unwind(AssertUnwindSafe(|| c.sweep(amount.map(U128)))).map_err(|e| {
        e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap()
    })
}

fn sweep(c: &mut Allowance, height: u64, amount: Option<u128>) -> Result<u64, String> {
    sweep_as(c, OWNER, height, amount, true)
}

/// The token answers `ft_balance_of(Payer Account)` with `balance`.
fn balance_is(c: &mut Allowance, id: u64, height: u64, balance: u128) -> Sweep {
    callback_ctx(height, PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(balance)).unwrap()));
    let _ = c.on_sweep_balance(id);
    current(c, id)
}

/// The sweep delegate as the test expects it, from the sweep's own key, nonce and expiry.
fn expected_delegate(s: &Sweep) -> FtTransferCallDelegate {
    FtTransferCallDelegate {
        sender_id: acc(PAYER),
        token_id: acc(USDC_ID),
        receiver_id: acc(ALLOWANCE),
        amount: s.amount.0,
        msg: format!("sweep:{}", s.id),
        nonce: s.nonce.unwrap(),
        max_block_height: s.max_block_height.unwrap(),
        gas: SWEEP_GAS,
        public_key: payer_key(s.key_index).verifying_key().to_bytes(),
    }
}

/// The signer answers with a valid signature over the expected delegate.
fn signed(c: &mut Allowance, id: u64, height: u64) -> Sweep {
    let s = get(c, id, height);
    let sig = payer_key(s.key_index).sign(&expected_delegate(&s).signable_hash()).to_bytes();
    callback_ctx(height, PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&json!({ "scheme": "Ed25519", "signature": sig.to_vec() })).unwrap(),
    ));
    c.on_sweep_signed(id);
    current(c, id)
}

fn get(c: &Allowance, id: u64, height: u64) -> Sweep {
    ctx(OWNER, height);
    current(c, id)
}

/// The sweep, read in the current context (so the last call's logs and receipts survive).
fn current(c: &Allowance, id: u64) -> Sweep {
    c.get_sweep(id).expect("sweep stored")
}

fn budget(c: &Allowance, height: u64) -> BudgetView {
    ctx(OWNER, height);
    c.get_budget()
}

fn pool(c: &Allowance, height: u64) -> KeyPoolStatus {
    ctx(OWNER, height);
    c.get_key_pool()
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

/// (receiver, method, args) of every function call the last contract call scheduled.
fn calls() -> Vec<(String, String, Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, args, .. } => Some((
                    receiver.clone(),
                    String::from_utf8(method_name).unwrap(),
                    near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null),
                )),
                _ => None,
            })
        })
        .collect()
}

/// One uncollected $3 payment on key 0, expired by height 1_060 + slack.
fn one_expired_payment() -> Allowance {
    let mut c = allowance(1);
    issue_payment(&mut c, 0, 3 * USD, 1_002); // valid through 1_060
    c
}

const AFTER_EXPIRY: u64 = 1_060 + SETTLEMENT_SLACK_BLOCKS + 1;

// ---- which key ---------------------------------------------------------------------

#[test]
fn a_sweep_is_refused_as_busy_while_every_key_has_an_unexpired_signed_payment_and_changes_nothing() {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, USD, 1_002);
    issue_payment(&mut c, 1, USD, 1_002);
    let before = budget(&c, 1_030);

    let err = sweep(&mut c, 1_030, None).unwrap_err();
    assert!(err.contains("busy: all signing keys are in use, retry from block 1061"), "{err}");
    // A delegate is still valid at its max_block_height.
    assert!(sweep(&mut c, 1_060, None).unwrap_err().contains("busy"));
    assert!(get_logs().is_empty() && get_created_receipts().is_empty(), "nothing emitted or scheduled");
    ctx(OWNER, 1_030);
    assert_eq!(c.get_sweep(0), None, "nothing stored");
    assert_eq!(budget(&c, 1_030), before);

    assert_eq!(sweep(&mut c, 1_061, None), Ok(0), "a key frees once its payment expires");
}

#[test]
fn a_sweep_leases_only_a_key_whose_payment_expired_and_signs_above_its_nonce() {
    let mut c = allowance(2);
    let old_key = issue_payment(&mut c, 0, USD, 1_002); // through 1_060
    let live_key = issue_payment(&mut c, 1, USD, 1_050); // through 1_108
    let old_nonce = c.get_request(rid(0)).unwrap().payment.unwrap().nonce;

    let id = sweep(&mut c, 1_061, None).unwrap(); // key 0 is free from 1_061
    let s = balance_is(&mut c, id, AFTER_EXPIRY, 2 * USD);
    assert_eq!(s.key_index, old_key);
    assert_ne!(s.key_index, live_key);
    assert!(s.nonce.unwrap() > old_nonce, "invalidates any older delegate on that key");
    assert_eq!(pool(&c, AFTER_EXPIRY).free, 0, "the sweep holds its key, so no Signed Payment can collide with it");
}

#[test]
fn only_one_sweep_is_checked_or_signed_at_a_time() {
    let mut c = allowance(2);
    let id = sweep(&mut c, 1_001, None).unwrap();
    assert!(sweep(&mut c, 1_001, None).unwrap_err().contains("busy: sweep 0 is still outstanding"));
    balance_is(&mut c, id, 1_002, 0); // refused: nothing there
    assert_eq!(sweep(&mut c, 1_003, None), Ok(1));
}

#[test]
fn a_signed_sweep_blocks_the_next_one_until_it_settles() {
    // Anyone can relay a signed sweep at any moment, so a second sweep's balance read could
    // be overtaken by it.
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002);
    let first = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    balance_is(&mut c, first, AFTER_EXPIRY, 3 * USD);
    signed(&mut c, first, AFTER_EXPIRY); // not relayed yet
    assert!(sweep(&mut c, AFTER_EXPIRY + 1, None).unwrap_err().contains("busy: sweep 0 is still outstanding"));
    deposit_at(&mut c, AFTER_EXPIRY + 2, PAYER, 3 * USD, "sweep:0");
    assert_eq!(sweep(&mut c, AFTER_EXPIRY + 2, None), Ok(1));
}

/// A sweep that is never relayed blocks the next one until its transfer could no longer land.
fn blocks_until_expired_plus_slack(signature_unavailable: bool) {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002);
    let first = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    let s = balance_is(&mut c, first, AFTER_EXPIRY, 3 * USD);
    if signature_unavailable {
        callback_ctx(AFTER_EXPIRY, PromiseResult::Failed);
        c.on_sweep_signed(first);
    } else {
        signed(&mut c, first, AFTER_EXPIRY);
    }
    let last = s.max_block_height.unwrap() + SETTLEMENT_SLACK_BLOCKS;
    assert!(sweep(&mut c, last, None).unwrap_err().contains("busy: sweep 0"));
    assert_eq!(sweep(&mut c, last + 1, None), Ok(1));
}

#[test]
fn a_signed_sweep_never_relayed_blocks_the_next_one_until_it_has_expired() {
    blocks_until_expired_plus_slack(false);
}

#[test]
fn a_sweep_without_a_signature_blocks_the_next_one_too() {
    // A late signature may still be published and relayed.
    blocks_until_expired_plus_slack(true);
}

#[test]
fn a_sweep_that_settles_after_the_next_one_was_requested_is_still_deducted() {
    // X = $3 (expired, key 0) and P = $4 (still valid, key 1) in the Payer Account. Sweep 0
    // takes X. If its USDC leaves after sweep 1's balance read, that read still shows X + P:
    // sweep 1 must not then take X again out of P's funds.
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002); // X, through 1_060
    issue_payment(&mut c, 1, 4 * USD, 1_080); // P, through 1_138
    let first = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    assert_eq!(balance_is(&mut c, first, AFTER_EXPIRY, 7 * USD).amount, U128(3 * USD));
    signed(&mut c, first, AFTER_EXPIRY);
    let settled_at = AFTER_EXPIRY + 2;
    deposit_at(&mut c, settled_at, PAYER, 3 * USD, "sweep:0");

    let second = sweep(&mut c, settled_at, None).unwrap();
    let s = balance_is(&mut c, second, settled_at + 1, 7 * USD); // read before sweep 0 left
    assert_eq!((s.outstanding, s.status), (Some(U128(7 * USD)), SweepStatus::Refused), "P's $4 stays put");
}

// ---- how much ----------------------------------------------------------------------

#[test]
fn the_amount_is_the_payer_balance_minus_unexpired_signed_payments() {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002); // expired by AFTER_EXPIRY
    issue_payment(&mut c, 1, 4 * USD, 1_050); // still valid then
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    let s = balance_is(&mut c, id, AFTER_EXPIRY + 1, 7 * USD);
    assert_eq!(s.status, SweepStatus::Signing);
    assert_eq!((s.payer_balance, s.outstanding, s.amount), (Some(U128(7 * USD)), Some(U128(4 * USD)), U128(3 * USD)));
}

/// (requested, swept) for an Owner asking `asked` with $3 sweepable.
fn ask(asked: u128) -> (Option<U128>, U128) {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, Some(asked)).unwrap();
    let s = balance_is(&mut c, id, AFTER_EXPIRY + 1, 3 * USD);
    (s.requested_amount, s.amount)
}

#[test]
fn the_owners_amount_is_capped_to_what_is_sweepable() {
    assert_eq!(ask(10 * USD), (Some(U128(10 * USD)), U128(3 * USD)));
}

#[test]
fn the_owner_may_sweep_less_than_is_sweepable() {
    assert_eq!(ask(USD), (Some(U128(USD)), U128(USD)));
}

#[test]
fn a_payment_that_just_expired_is_still_deducted_while_its_transfer_may_be_in_flight() {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002); // through 1_060
    let id = sweep(&mut c, 1_061, None).unwrap();
    let s = balance_is(&mut c, id, 1_062, 3 * USD);
    assert_eq!(s.status, SweepStatus::Refused);
}

#[test]
fn a_spend_still_being_funded_is_deducted() {
    // Approved and its transfer into the Payer Account has landed, but `on_payer_funded`
    // hasn't issued it yet: its key is leased for funding, and the USDC is not sweepable.
    let mut c = allowance(2);
    ctx(ALLOWANCE, 1_000);
    assert_eq!(c.request_spend(rid(0), acc(PAYEE), U128(3 * USD), None, 60).status, Status::Funding);
    let id = sweep(&mut c, 1_001, None).unwrap();
    let s = balance_is(&mut c, id, 1_002, 3 * USD);
    assert_eq!((s.outstanding, s.status), (Some(U128(3 * USD)), SweepStatus::Refused));
}

#[test]
fn nothing_to_sweep_is_refused_and_gives_its_key_back() {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_050); // still valid
    let id = sweep(&mut c, 1_060, None).unwrap();
    assert_eq!(pool(&c, 1_060).free, 0);
    let s = balance_is(&mut c, id, 1_061, 3 * USD);
    assert_eq!(s.status, SweepStatus::Refused);
    assert!(s.refused_reason.unwrap().contains("nothing to sweep"));
    assert_eq!(events("sweep_refused").len(), 1);
    assert!(calls().is_empty(), "nothing sent to the signer");
    assert_eq!(pool(&c, 1_061).free, 1, "the sweep's key is free again");
}

#[test]
fn an_unreadable_payer_balance_refuses_the_sweep() {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    callback_ctx(AFTER_EXPIRY, PromiseResult::Failed);
    let _ = c.on_sweep_balance(id);
    assert_eq!(get(&c, id, AFTER_EXPIRY).status, SweepStatus::Refused);
    assert_eq!(pool(&c, AFTER_EXPIRY).free, 1);
}

// ---- who ---------------------------------------------------------------------------

#[test]
fn only_the_owner_can_sweep() {
    let mut c = one_expired_payment();
    assert!(sweep_as(&mut c, "stranger.testnet", AFTER_EXPIRY, None, true).unwrap_err().contains("only the Owner"));
    assert!(sweep_as(&mut c, ALLOWANCE, AFTER_EXPIRY, None, true).unwrap_err().contains("only the Owner"), "not the Agent");
}

#[test]
fn a_sweep_needs_the_owners_confirmation() {
    let mut c = one_expired_payment();
    assert!(sweep_as(&mut c, OWNER, AFTER_EXPIRY, None, false).unwrap_err().contains("Requires attached deposit of exactly 1 yoctoNEAR"));
}

#[test]
fn a_zero_amount_is_refused() {
    let mut c = one_expired_payment();
    assert!(sweep(&mut c, AFTER_EXPIRY, Some(0)).unwrap_err().contains("amount must be positive"));
}

// ---- signing -----------------------------------------------------------------------

#[test]
fn the_sweep_reads_the_payer_balance_then_signs_one_ft_transfer_call_back_to_the_allowance() {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    assert_eq!(id, 0);
    assert_eq!(events("sweep_requested"), vec![json!({ "id": 0, "requested_amount": null, "key_index": 0 })]);
    assert!(calls().contains(&(USDC_ID.into(), "ft_balance_of".into(), json!({ "account_id": PAYER }))));
    assert_eq!(get(&c, id, AFTER_EXPIRY).status, SweepStatus::Checking);

    let s = balance_is(&mut c, id, AFTER_EXPIRY + 1, 3 * USD);
    let d = expected_delegate(&s);
    let sign = calls().into_iter().find(|(_, m, _)| m == "sign").expect("sent to the signer");
    assert_eq!(sign.2["request"]["path"], "x402/0");
    assert_eq!(sign.2["request"]["payload_v2"]["Eddsa"], hex::encode(d.signable_hash()));
    assert_eq!(
        String::from_utf8(d.ft_transfer_call_args()).unwrap(),
        format!(r#"{{"receiver_id":"{ALLOWANCE}","amount":"3000000","msg":"sweep:0"}}"#)
    );

    let s = signed(&mut c, id, AFTER_EXPIRY + 3);
    assert_eq!(s.status, SweepStatus::Signed);
    let sig = payer_key(0).sign(&d.signable_hash()).to_bytes();
    assert_eq!(s.signed_delegate_action, Some(d.signed_delegate_action_base64(&sig)));
    assert_eq!(
        events("sweep_signed"),
        vec![json!({
            "id": 0, "amount": "3000000", "key_index": 0,
            "nonce": s.nonce, "max_block_height": s.max_block_height,
        })]
    );
}

#[test]
fn a_bad_signature_ends_the_sweep_and_its_key_stays_leased_until_it_expires() {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    let s = balance_is(&mut c, id, AFTER_EXPIRY, 3 * USD);
    callback_ctx(AFTER_EXPIRY, PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&json!({ "scheme": "Ed25519", "signature": vec![7u8; 64] })).unwrap(),
    ));
    c.on_sweep_signed(id);
    assert_eq!(events("sweep_signature_unavailable").len(), 1);
    assert_eq!(current(&c, id).status, SweepStatus::SignatureUnavailable);
    let until = s.max_block_height.unwrap();
    assert_eq!(pool(&c, until).free, 0);
    assert_eq!(pool(&c, until + 1).free, 1);
}

#[test]
fn a_signed_sweep_never_relayed_shows_expired() {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    balance_is(&mut c, id, AFTER_EXPIRY, 3 * USD);
    let s = signed(&mut c, id, AFTER_EXPIRY);
    let until = s.max_block_height.unwrap();
    assert_eq!(get(&c, id, until).status, SweepStatus::Signed);
    assert_eq!(get(&c, id, until + 1).status, SweepStatus::Expired);
}

// ---- the USDC comes back -----------------------------------------------------------

#[test]
fn returned_usdc_is_credited_and_withdrawable_and_the_sweep_settles() {
    let mut c = one_expired_payment();
    let before = budget(&c, AFTER_EXPIRY);
    assert_eq!((before.usdc_balance, before.withdrawable), (U128(97 * USD), U128(97 * USD)));
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    balance_is(&mut c, id, AFTER_EXPIRY, 3 * USD);
    signed(&mut c, id, AFTER_EXPIRY);
    assert_eq!(pool(&c, AFTER_EXPIRY + 1).free, 0);

    // The relayed ft_transfer_call notifies the Allowance.
    deposit_at(&mut c, AFTER_EXPIRY, PAYER, 3 * USD, "sweep:0");
    assert_eq!(events("sweep_settled"), vec![json!({ "id": 0, "amount": "3000000" })]);
    assert_eq!(events("deposit").len(), 1);
    assert_eq!(get(&c, id, AFTER_EXPIRY + 1).status, SweepStatus::Settled);
    let after = budget(&c, AFTER_EXPIRY + 1);
    assert_eq!((after.usdc_balance, after.withdrawable), (U128(100 * USD), U128(100 * USD)));
    assert_eq!(pool(&c, AFTER_EXPIRY + 1).free, 1, "its nonce is used: the key is free at once");

    // And the Owner can take it out.
    ctx(OWNER, AFTER_EXPIRY + 2);
    common::confirm();
    let _ = c.withdraw(U128(100 * USD));
    assert!(calls().contains(&(USDC_ID.into(), "ft_transfer".into(), json!({ "receiver_id": OWNER, "amount": "100000000", "memo": null }))));
}

#[test]
fn a_deposit_that_is_not_this_sweeps_return_is_credited_but_settles_nothing() {
    let mut c = one_expired_payment();
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    balance_is(&mut c, id, AFTER_EXPIRY, 3 * USD);
    signed(&mut c, id, AFTER_EXPIRY);
    for (sender, amount, msg) in [
        (OWNER, 3 * USD, "sweep:0"), // not from the Payer Account
        (PAYER, 2 * USD, "sweep:0"), // not the sweep's amount
        (PAYER, 3 * USD, "sweep:9"), // no such sweep
    ] {
        deposit_at(&mut c, AFTER_EXPIRY, sender, amount, msg);
        assert_eq!(events("deposit").len(), 1);
        assert!(events("sweep_settled").is_empty(), "{sender} {amount} {msg}");
    }
    assert_eq!(get(&c, id, AFTER_EXPIRY).status, SweepStatus::Signed);
    assert_eq!(budget(&c, AFTER_EXPIRY).usdc_balance, U128(105 * USD), "every deposit is still credited");
}

#[test]
fn the_daily_cap_is_unaffected_by_a_sweep() {
    let mut c = one_expired_payment();
    let cap_before = budget(&c, AFTER_EXPIRY).cap;
    assert_eq!(cap_before.used_in_window, U128(3 * USD));
    let id = sweep(&mut c, AFTER_EXPIRY, None).unwrap();
    balance_is(&mut c, id, AFTER_EXPIRY, 3 * USD);
    signed(&mut c, id, AFTER_EXPIRY);
    deposit_at(&mut c, AFTER_EXPIRY, PAYER, 3 * USD, "sweep:0");
    assert_eq!(budget(&c, AFTER_EXPIRY).cap, cap_before, "the swept payment still counts for its window");
}

#[test]
fn a_settled_sweep_is_no_longer_deducted_from_the_next_one() {
    let mut c = allowance(2);
    issue_payment(&mut c, 0, 3 * USD, 1_002);
    let first = sweep(&mut c, AFTER_EXPIRY, Some(USD)).unwrap();
    balance_is(&mut c, first, AFTER_EXPIRY, 3 * USD);
    signed(&mut c, first, AFTER_EXPIRY);
    deposit_at(&mut c, AFTER_EXPIRY, PAYER, USD, "sweep:0");
    let second = sweep(&mut c, AFTER_EXPIRY + 1, None).unwrap();
    let s = balance_is(&mut c, second, AFTER_EXPIRY + 1, 2 * USD);
    assert_eq!((s.outstanding, s.amount), (Some(U128(0)), U128(2 * USD)));
}
