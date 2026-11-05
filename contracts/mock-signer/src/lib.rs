//! Mock Chain Signatures (MPC) signer. SANDBOX ONLY: anyone can register keys and publish
//! signatures, so it must never be deployed anywhere real.
//!
//! It mimics the parts of `v1.signer-prod.testnet` the Allowance contract relies on:
//! - `derived_public_key(path, predecessor, domain_id)` returns an `ed25519:<base58>` key, but
//!   from a table the test harness fills with `register_derived_key` instead of real derivation.
//! - `sign(request)` needs at least 1 yoctoNEAR, only accepts Eddsa on domain 1, and returns a
//!   yielded promise that resolves to `{"scheme":"Ed25519","signature":[64 bytes]}`.
//! - The harness plays the MPC network: it reads `pending_requests()`, signs off-chain, and calls
//!   `respond(id, signature)`, which resumes the yield.
//! - With no response within the yield timeout (~200 blocks) the `sign` call fails with
//!   "Signature request has timed out.", like the real signer. A late `respond` still records
//!   the signature (`published_signature`) but delivers nothing. The real signer may instead
//!   reject a late `respond`; either way the signature is public on chain in the `respond`
//!   transaction, which is what "a late signature counts as spent" (ADR 0003) guards against.

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
    PublicKey, YieldId, env, near, require,
};

/// Gas for the yield callback `return_signature`.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas for `fail_on_timeout`, scheduled by the callback when the yield timed out.
const FAIL_GAS: Gas = Gas::from_tgas(2);
/// Chain Signatures domain id of Ed25519 (EdDSA).
const EDDSA_DOMAIN: u64 = 1;

#[near(serializers = [json])]
pub enum SignPayload {
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: SignPayload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

/// A sign request waiting for the harness to `respond`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSignature {
    pub id: u64,
    pub predecessor: AccountId,
    pub path: String,
    pub payload_hex: String,
    pub domain_id: u64,
}

#[near(serializers = [borsh])]
struct PendingEntry {
    request: PendingSignature,
    yield_id: YieldId,
    timed_out: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    /// (predecessor, path) -> `ed25519:<base58>` public key.
    keys: LookupMap<(AccountId, String), String>,
    pending: IterableMap<u64, PendingEntry>,
    published: LookupMap<u64, Vec<u8>>,
    next_id: u64,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self {
            keys: LookupMap::new(b"k"),
            pending: IterableMap::new(b"p"),
            published: LookupMap::new(b"s"),
            next_id: 0,
        }
    }

    /// Sandbox only: anyone may register the key `derived_public_key` returns.
    pub fn register_derived_key(&mut self, predecessor: AccountId, path: String, public_key: String) {
        let pk: PublicKey = public_key.parse().expect("invalid public key");
        require!(pk.as_bytes().len() == 33 && pk.as_bytes()[0] == 0, "public key must be ed25519");
        self.keys.insert((predecessor, path), public_key);
    }

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        require!(domain_id.unwrap_or(EDDSA_DOMAIN) == EDDSA_DOMAIN, "mock only supports domain 1 (Eddsa)");
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        self.keys.get(&(predecessor, path)).cloned().unwrap_or_else(|| env::panic_str("unknown derived key"))
    }

    /// Records a pending request and yields until `respond` or the yield timeout.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> Promise {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "attach at least 1 yoctoNEAR"
        );
        let SignPayload::Eddsa(payload_hex) = request.payload_v2;
        require!(request.domain_id == EDDSA_DOMAIN, "Eddsa payloads need domain_id 1");
        require!(hex::decode(&payload_hex).is_ok(), "payload is not valid hex");

        let id = self.next_id;
        self.next_id += 1;
        let args = near_sdk::serde_json::json!({ "id": id }).to_string();
        let (promise, yield_id) =
            Promise::new_yield("return_signature", args, CALLBACK_GAS, GasWeight(0));
        self.pending.insert(
            id,
            PendingEntry {
                request: PendingSignature {
                    id,
                    predecessor: env::predecessor_account_id(),
                    path: request.path,
                    payload_hex,
                    domain_id: request.domain_id,
                },
                yield_id,
                timed_out: false,
            },
        );
        promise
    }

    /// Sandbox only: anyone may publish the signature for request `id`. Always recorded, so a
    /// late response is visible; returns whether it reached the waiting `sign` call.
    pub fn respond(&mut self, id: u64, signature: Vec<u8>) -> bool {
        require!(signature.len() == 64, "signature must be 64 bytes");
        let entry = self.pending.remove(&id).unwrap_or_else(|| env::panic_str("unknown request id"));
        self.published.insert(id, signature.clone());
        let response = SignResponse { scheme: "Ed25519".into(), signature };
        let data = near_sdk::serde_json::to_vec(&response).unwrap();
        !entry.timed_out && entry.yield_id.resume(data).is_ok()
    }

    /// Yield callback: hands the response to `sign`'s caller, or fails it on timeout.
    #[private]
    pub fn return_signature(
        &mut self,
        id: u64,
        #[callback_result] response: Result<SignResponse, PromiseError>,
    ) -> PromiseOrValue<SignResponse> {
        match response {
            Ok(r) => PromiseOrValue::Value(r),
            Err(_) => {
                // Commit the timed-out mark, then fail in a separate receipt (as the real MPC
                // does) so `sign`'s caller sees an error without reverting this state change.
                if let Some(e) = self.pending.get_mut(&id) {
                    e.timed_out = true;
                }
                PromiseOrValue::Promise(
                    Promise::new(env::current_account_id())
                        .function_call("fail_on_timeout", Vec::new(), NearToken::from_yoctonear(0), FAIL_GAS),
                )
            }
        }
    }

    #[private]
    pub fn fail_on_timeout(&self) {
        env::panic_str("Signature request has timed out.");
    }

    pub fn pending_requests(&self) -> Vec<PendingSignature> {
        self.pending.values().filter(|e| !e.timed_out).map(|e| e.request.clone()).collect()
    }

    pub fn published_signature(&self, id: u64) -> Option<Vec<u8>> {
        self.published.get(&id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

    fn ctx(predecessor: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("signer.test.near".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn request(domain_id: u64) -> SignRequest {
        SignRequest {
            path: "x402/0".into(),
            payload_v2: SignPayload::Eddsa("ab".repeat(32)),
            domain_id,
        }
    }

    #[test]
    fn derived_key_lookup() {
        ctx("allowance.test.near", 0);
        let mut c = MockSigner::new();
        c.register_derived_key("allowance.test.near".parse().unwrap(), "x402/0".into(), KEY.into());
        assert_eq!(c.derived_public_key("x402/0".into(), None, Some(1)), KEY);
        assert_eq!(
            c.derived_public_key("x402/0".into(), Some("allowance.test.near".parse().unwrap()), None),
            KEY
        );
    }

    #[test]
    #[should_panic(expected = "unknown derived key")]
    fn unknown_derived_key() {
        ctx("allowance.test.near", 0);
        let mut c = MockSigner::new();
        c.register_derived_key("allowance.test.near".parse().unwrap(), "x402/0".into(), KEY.into());
        c.derived_public_key("x402/1".into(), None, None);
    }

    #[test]
    #[should_panic(expected = "public key must be ed25519")]
    fn register_rejects_secp() {
        ctx("allowance.test.near", 0);
        let mut c = MockSigner::new();
        c.register_derived_key(
            "a.near".parse().unwrap(),
            "p".into(),
            "secp256k1:qMoRgcoXai4mBPsdbHi1wfyxF9TdbPCF4qSDQTRP3TfescSRoUdSx6nmeQoN3aiwGzwMyGXAb1gUjBTv5AY8DXj".into(),
        );
    }

    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR")]
    fn sign_requires_deposit() {
        ctx("allowance.test.near", 0);
        let _ = MockSigner::new().sign(request(1));
    }

    #[test]
    #[should_panic(expected = "Eddsa payloads need domain_id 1")]
    fn sign_requires_eddsa_domain() {
        ctx("allowance.test.near", 1);
        let _ = MockSigner::new().sign(request(0));
    }

    #[test]
    fn sign_records_pending_and_respond_publishes() {
        ctx("allowance.test.near", 1);
        let mut c = MockSigner::new();
        let _ = c.sign(request(1));
        assert_eq!(
            c.pending_requests(),
            vec![PendingSignature {
                id: 0,
                predecessor: "allowance.test.near".parse().unwrap(),
                path: "x402/0".into(),
                payload_hex: "ab".repeat(32),
                domain_id: 1,
            }]
        );
        assert_eq!(c.published_signature(0), None);

        ctx("harness.test.near", 0);
        // Delivery (the bool) needs a real yield; sandbox tests cover it.
        let _ = c.respond(0, vec![7; 64]);
        assert_eq!(c.published_signature(0), Some(vec![7; 64]));
        assert!(c.pending_requests().is_empty());
    }

    #[test]
    #[should_panic(expected = "unknown request id")]
    fn respond_unknown_id() {
        ctx("harness.test.near", 0);
        MockSigner::new().respond(5, vec![0; 64]);
    }
}
