//! Byte-for-byte checks of the delegate encoding against golden vectors made
//! by the official NEAR JS encoder (`packages/golden-vectors`). Expected values
//! come only from the fixture, never from re-deriving them in Rust.

use allowance::delegate::FtTransferDelegate;
use near_sdk::serde_json::{self, Value};

const FIXTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/golden-vectors/fixtures/delegate-vectors.json"
));

struct Case {
    name: String,
    delegate: FtTransferDelegate,
    signature: [u8; 64],
    expected: Value,
}

fn cases() -> Vec<Case> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 5, "fixture should hold several cases");
    cases
        .iter()
        .map(|c| {
            let input = &c["input"];
            let s = |k: &str| {
                input[k]
                    .as_str()
                    .unwrap_or_else(|| panic!("input.{k}"))
                    .to_owned()
            };
            Case {
                name: c["name"].as_str().unwrap().to_owned(),
                delegate: FtTransferDelegate {
                    sender_id: s("sender_id").parse().unwrap(),
                    token_id: s("token_id").parse().unwrap(),
                    payee: s("payee").parse().unwrap(),
                    amount: s("amount").parse().unwrap(),
                    nonce: s("nonce").parse().unwrap(),
                    max_block_height: s("max_block_height").parse().unwrap(),
                    gas: s("gas").parse().unwrap(),
                    public_key: hex::decode(s("public_key_hex")).unwrap().try_into().unwrap(),
                },
                signature: hex::decode(s("signature_hex")).unwrap().try_into().unwrap(),
                expected: c["expected"].clone(),
            }
        })
        .collect()
}

fn expected<'a>(case: &'a Case, key: &str) -> &'a str {
    case.expected[key].as_str().unwrap_or_else(|| panic!("expected.{key}"))
}

#[test]
fn ft_transfer_args_match_reference_json() {
    for case in cases() {
        let args = case.delegate.ft_transfer_args();
        assert_eq!(
            String::from_utf8(args).unwrap(),
            expected(&case, "ft_transfer_args_utf8"),
            "case {}",
            case.name
        );
    }
}

#[test]
fn delegate_action_bytes_match_reference_encoder() {
    for case in cases() {
        assert_eq!(
            hex::encode(case.delegate.delegate_action_bytes()),
            expected(&case, "delegate_action_hex"),
            "case {}",
            case.name
        );
    }
}

#[test]
fn signable_message_matches_reference_encoder() {
    for case in cases() {
        assert_eq!(
            hex::encode(case.delegate.signable_message()),
            expected(&case, "signable_message_hex"),
            "case {}",
            case.name
        );
    }
}

#[test]
fn signable_hash_matches_sha256_of_reference_message() {
    for case in cases() {
        assert_eq!(
            hex::encode(case.delegate.signable_hash()),
            expected(&case, "signable_message_sha256_hex"),
            "case {}",
            case.name
        );
    }
}

#[test]
fn signed_delegate_action_bytes_match_reference_encoder() {
    for case in cases() {
        assert_eq!(
            hex::encode(case.delegate.signed_delegate_action_bytes(&case.signature)),
            expected(&case, "signed_delegate_action_hex"),
            "case {}",
            case.name
        );
    }
}

#[test]
fn signed_delegate_action_base64_matches_reference_encoder() {
    for case in cases() {
        assert_eq!(
            case.delegate.signed_delegate_action_base64(&case.signature),
            expected(&case, "signed_delegate_action_base64"),
            "case {}",
            case.name
        );
    }
}
