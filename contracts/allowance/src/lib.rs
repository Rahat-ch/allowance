//! Allowance: an on-chain budget an AI Agent can spend through x402 Signed Payments.
//!
//! Ticket #2 tracer: the contract creates its Payer Account with keys derived through
//! Chain Signatures, and issues one Signed Payment (an x402 `exact` NEP-366 delegate
//! holding a single `ft_transfer`) that it builds and has signed itself (ADR 0003).

pub mod delegate;

use delegate::FtTransferDelegate;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
    env, ext_contract, near, require,
};

/// Gas the inner `ft_transfer` of a Signed Payment may use (x402's default).
const FT_TRANSFER_GAS: u64 = 30_000_000_000_000;
/// NEAR kept in the Payer Account for its own storage (account + keys).
const PAYER_ACCOUNT_BALANCE: NearToken = NearToken::from_millinear(100);
/// NEP-145 storage deposit for one USDC account registration.
const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1_250);
/// Chain Signatures `sign` needs at least 15 TGas plus room for the yield (docs/notes).
const SIGN_GAS: Gas = Gas::from_tgas(50);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentStatus {
    /// Moving the amount from the Allowance into the Payer Account.
    Funding,
    /// The delegate is built and sent to the signer. Counts as spent from here on.
    Signing,
    /// The Signed Payment is ready for the Agent to hand to the seller.
    Signed,
    /// Funding failed before anything was sent to the signer; nothing was spent.
    FundingFailed,
    /// The signer didn't deliver a signature. Still counts as spent (ADR 0003).
    SignatureUnavailable,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignedPayment {
    pub status: PaymentStatus,
    pub payee: AccountId,
    pub amount: U128,
    pub key_index: u32,
    pub max_timeout_blocks: u64,
    pub public_key: Option<String>,
    pub nonce: Option<u64>,
    pub max_block_height: Option<u64>,
    /// Base64 borsh `SignedDelegateAction`, the x402 `exact` NEAR payload.
    pub signed_delegate_action: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Allowance {
    owner_id: AccountId,
    asset_id: AccountId,
    signer_id: AccountId,
    domain_id: u64,
    /// Ed25519 public keys of the Payer Account, derived for paths `x402/<index>`.
    payer_keys: Vec<[u8; 32]>,
    /// Highest delegate nonce used per Payer Account key.
    last_nonce: Vec<u64>,
    payments: LookupMap<String, SignedPayment>,
    payment_count: u64,
    /// True while `create_payer_account` is waiting on its callbacks.
    payer_creating: bool,
}

// ---- external interfaces -------------------------------------------------------------

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
pub struct SignResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[ext_contract(ext_signer)]
#[allow(dead_code)]
trait ChainSignatures {
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
    fn sign(&mut self, request: SignRequest) -> SignResponse;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: AccountId, registration_only: bool);
}

// ---- contract ------------------------------------------------------------------------

#[near]
impl Allowance {
    #[init]
    pub fn new(owner_id: AccountId, asset_id: AccountId, signer_id: AccountId, domain_id: u64) -> Self {
        Self {
            owner_id,
            asset_id,
            signer_id,
            domain_id,
            payer_keys: Vec::new(),
            last_nonce: Vec::new(),
            payments: LookupMap::new(b"p"),
            payment_count: 0,
            payer_creating: false,
        }
    }

    /// The Payer Account: a sub-account only this contract can sign for.
    pub fn payer_account_id(&self) -> AccountId {
        format!("pay.{}", env::current_account_id()).parse().unwrap()
    }

    pub fn payer_keys(&self) -> Vec<String> {
        self.payer_keys.iter().map(|k| ed25519_string(k)).collect()
    }

    pub fn get_signed_payment(&self, request_id: String) -> Option<SignedPayment> {
        self.payments.get(&request_id).cloned()
    }

    /// Owner only. Fetches `key_count` derived keys from the signer, then creates the Payer
    /// Account holding only those keys and registers it with the USDC contract.
    #[payable]
    pub fn create_payer_account(&mut self, key_count: u32) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "only the Owner");
        require!(self.payer_keys.is_empty(), "payer account already created");
        require!(!self.payer_creating, "payer account creation already in progress");
        require!((1..=32).contains(&key_count), "key_count must be 1..=32");
        self.payer_creating = true;
        let fetch = |i: u32| {
            ext_signer::ext(self.signer_id.clone())
                .with_static_gas(Gas::from_tgas(5))
                .derived_public_key(
                    derivation_path(i),
                    Some(env::current_account_id()),
                    Some(self.domain_id),
                )
        };
        let mut all = fetch(0);
        for i in 1..key_count {
            all = all.and(fetch(i));
        }
        all.then(
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(60))
                .on_payer_keys(key_count),
        )
    }

    /// Receives the derived keys and creates the Payer Account with only those keys.
    /// Keys are recorded only once the account exists (see `on_payer_created`).
    #[private]
    pub fn on_payer_keys(&mut self, key_count: u32) -> PromiseOrValue<()> {
        let mut keys = Vec::with_capacity(key_count as usize);
        for i in 0..key_count as u64 {
            let parsed = env::promise_result_checked(i, 200)
                .ok()
                .and_then(|raw| near_sdk::serde_json::from_slice::<String>(&raw).ok())
                .and_then(|s| try_parse_ed25519(&s));
            match parsed {
                Some(k) => keys.push(k),
                None => {
                    self.payer_creating = false;
                    env::log_str("derived_public_key failed; payer account not created");
                    return PromiseOrValue::Value(());
                }
            }
        }
        let mut create = Promise::new(self.payer_account_id())
            .create_account()
            .transfer(PAYER_ACCOUNT_BALANCE);
        for k in &keys {
            create = create.add_full_access_key(ed25519_public_key(k));
        }
        PromiseOrValue::Promise(
            create.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_payer_created(keys.iter().map(ed25519_string).collect()),
            ),
        )
    }

    /// Records the Payer Account's keys only if the account was really created, then
    /// registers it with the USDC contract.
    #[private]
    pub fn on_payer_created(
        &mut self,
        keys: Vec<String>,
        #[callback_result] created: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        self.payer_creating = false;
        if created.is_err() {
            env::log_str("payer account creation failed; keys not recorded");
            return PromiseOrValue::Value(());
        }
        let keys: Vec<[u8; 32]> =
            keys.iter().map(|k| try_parse_ed25519(k).expect("bad payer key")).collect();
        self.last_nonce = vec![0; keys.len()];
        self.payer_keys = keys;
        PromiseOrValue::Promise(
            ext_ft::ext(self.asset_id.clone())
                .with_attached_deposit(FT_STORAGE_DEPOSIT)
                .with_static_gas(Gas::from_tgas(10))
                .storage_deposit(self.payer_account_id(), true),
        )
    }

    /// Agent only (its function-call key lives on this account, so it calls as itself).
    /// Tracer for ticket #2: issues one Signed Payment with no Policy checks yet.
    pub fn tracer_sign(
        &mut self,
        request_id: String,
        payee: AccountId,
        amount: U128,
        max_timeout_blocks: u64,
    ) -> Promise {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the Agent can request a Signed Payment"
        );
        require!(
            valid_request_id(&request_id),
            "request_id must be 16-128 characters of [A-Za-z0-9_-]"
        );
        require!(!self.payments.contains_key(&request_id), "request id already used");
        require!(!self.payer_keys.is_empty(), "payer account not created");
        require!(amount.0 > 0, "amount must be positive");
        require!((1..=600).contains(&max_timeout_blocks), "max_timeout_blocks must be 1..=600");

        let key_index = (self.payment_count % self.payer_keys.len() as u64) as u32;
        self.payment_count += 1;
        self.payments.insert(
            request_id.clone(),
            SignedPayment {
                status: PaymentStatus::Funding,
                payee,
                amount,
                key_index,
                max_timeout_blocks,
                public_key: None,
                nonce: None,
                max_block_height: None,
                signed_delegate_action: None,
            },
        );
        ext_ft::ext(self.asset_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .ft_transfer(self.payer_account_id(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(100))
                    .on_payer_funded(request_id),
            )
    }

    #[private]
    pub fn on_payer_funded(
        &mut self,
        request_id: String,
        #[callback_result] funded: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        let mut p = self.payments.get(&request_id).cloned().expect("unknown request");
        if funded.is_err() {
            p.status = PaymentStatus::FundingFailed;
            self.payments.insert(request_id, p);
            return PromiseOrValue::Value(());
        }
        let k = p.key_index as usize;
        let height = env::block_height();
        // The nonce must exceed the key's on-chain nonce (keys start at their creation height
        // x 1e6) and stay below the facilitator's final height x 1e6, so use the previous
        // block's range plus a per-key sequence.
        let nonce = ((height - 1) * 1_000_000).max(self.last_nonce[k] + 1);
        self.last_nonce[k] = nonce;
        p.status = PaymentStatus::Signing;
        p.public_key = Some(ed25519_string(&self.payer_keys[k]));
        p.nonce = Some(nonce);
        p.max_block_height = Some(height + p.max_timeout_blocks);
        let d = self.delegate_for(&p);
        self.payments.insert(request_id.clone(), p);

        PromiseOrValue::Promise(
            ext_signer::ext(self.signer_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(SIGN_GAS)
                .sign(SignRequest {
                    path: derivation_path(k as u32),
                    payload_v2: SignPayload::Eddsa(hex::encode(d.signable_hash())),
                    domain_id: self.domain_id,
                })
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(15))
                        .on_signed(request_id),
                ),
        )
    }

    #[private]
    pub fn on_signed(
        &mut self,
        request_id: String,
        #[callback_result] signed: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        // Parse leniently: an unexpected response must end the payment, never revert this
        // callback and leave it Signing forever.
        let mut p = self.payments.get(&request_id).cloned().expect("unknown request");
        let d = self.delegate_for(&p);
        let sig: Option<[u8; 64]> = signed
            .ok()
            .and_then(|v| near_sdk::serde_json::from_value::<SignResponse>(v).ok())
            .filter(|r| r.scheme == "Ed25519")
            .and_then(|r| r.signature.try_into().ok())
            .filter(|sig| {
                env::ed25519_verify(sig, &d.signable_hash(), &self.payer_keys[p.key_index as usize])
            });
        match sig {
            Some(sig) => {
                p.signed_delegate_action = Some(d.signed_delegate_action_base64(&sig));
                p.status = PaymentStatus::Signed;
            }
            None => p.status = PaymentStatus::SignatureUnavailable,
        }
        self.payments.insert(request_id, p);
    }
}

impl Allowance {
    fn delegate_for(&self, p: &SignedPayment) -> FtTransferDelegate {
        FtTransferDelegate {
            sender_id: self.payer_account_id(),
            token_id: self.asset_id.clone(),
            payee: p.payee.clone(),
            amount: p.amount.0,
            nonce: p.nonce.expect("nonce set"),
            max_block_height: p.max_block_height.expect("height set"),
            gas: FT_TRANSFER_GAS,
            public_key: self.payer_keys[p.key_index as usize],
        }
    }

    /// Test-only: seed Payer Account keys without the cross-contract derivation.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn set_payer_keys_for_test(&mut self, keys: Vec<[u8; 32]>) {
        self.last_nonce = vec![0; keys.len()];
        self.payer_keys = keys;
    }
}

/// Chain Signatures derivation path of Payer Account key `index`.
fn derivation_path(index: u32) -> String {
    format!("x402/{index}")
}

fn try_parse_ed25519(s: &str) -> Option<[u8; 32]> {
    let pk: PublicKey = s.parse().ok()?;
    let bytes = pk.as_bytes();
    if bytes.len() != 33 || bytes[0] != 0 {
        return None;
    }
    bytes[1..].try_into().ok()
}

fn valid_request_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn ed25519_public_key(k: &[u8; 32]) -> PublicKey {
    ed25519_string(k).parse().unwrap()
}

fn ed25519_string(k: &[u8; 32]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k).into_string())
}
