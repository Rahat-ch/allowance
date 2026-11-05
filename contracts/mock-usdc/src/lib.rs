//! Mock USDC: a sandbox-only NEP-141 fungible token standing in for Circle USDC.
//!
//! Behaviour follows `near_contract_standards::fungible_token::FungibleToken`
//! (NEP-141 core + NEP-145 storage + NEP-148 metadata). Adds an owner-only
//! `mint` for funding test accounts. Never deploy this to mainnet.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, near, require,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    FungibleToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut this = Self {
            owner_id: owner_id.clone(),
            token: FungibleToken::new(StorageKey::FungibleToken),
        };
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.into());
        FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("new tokens are minted"),
        }
        .emit();
        this
    }

    /// Sandbox convenience: owner mints `amount` to a registered `account_id`.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can mint"
        );
        // internal_deposit panics if the account is not registered.
        self.token.internal_deposit(&account_id, amount.into());
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mock mint"),
        }
        .emit();
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            near_contract_standards::fungible_token::events::FtBurn {
                owner_id: &sender_id,
                amount: U128(burned_amount),
                memo: Some("refund burned"),
            }
            .emit();
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            near_contract_standards::fungible_token::events::FtBurn {
                owner_id: &account_id,
                amount: U128(balance),
                memo: Some("account unregistered"),
            }
            .emit();
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USDC".to_string(),
            symbol: "USDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    const SUPPLY: u128 = 1_000_000_000_000; // 1M USDC at 6 decimals

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor);
        b
    }

    fn setup() -> Contract {
        testing_env!(ctx(accounts(1)).build());
        Contract::new(accounts(1), U128(SUPPLY))
    }

    fn register(c: &mut Contract, who: AccountId) {
        let min = c.storage_balance_bounds().min;
        testing_env!(ctx(who.clone()).attached_deposit(min).build());
        c.storage_deposit(Some(who), Some(true));
    }

    #[test]
    fn init_mints_supply_to_owner() {
        let c = setup();
        assert_eq!(c.ft_total_supply().0, SUPPLY);
        assert_eq!(c.ft_balance_of(accounts(1)).0, SUPPLY);
        assert!(c.storage_balance_of(accounts(1)).is_some());
        let m = c.ft_metadata();
        assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals), ("Mock USDC", "USDC", 6));
    }

    #[test]
    fn owner_mints_to_registered_account() {
        let mut c = setup();
        register(&mut c, accounts(2));
        testing_env!(ctx(accounts(1)).build());
        c.mint(accounts(2), U128(500));
        assert_eq!(c.ft_balance_of(accounts(2)).0, 500);
        assert_eq!(c.ft_total_supply().0, SUPPLY + 500);
    }

    #[test]
    #[should_panic(expected = "Only the owner can mint")]
    fn non_owner_cannot_mint() {
        let mut c = setup();
        register(&mut c, accounts(2));
        testing_env!(ctx(accounts(2)).build());
        c.mint(accounts(2), U128(500));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn mint_to_unregistered_panics() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        c.mint(accounts(3), U128(1));
    }

    #[test]
    fn transfer_moves_balance() {
        let mut c = setup();
        register(&mut c, accounts(2));
        testing_env!(ctx(accounts(1)).attached_deposit(NearToken::from_yoctonear(1)).build());
        c.ft_transfer(accounts(2), U128(1_000), None);
        assert_eq!(c.ft_balance_of(accounts(2)).0, 1_000);
        assert_eq!(c.ft_balance_of(accounts(1)).0, SUPPLY - 1_000);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut c = setup();
        register(&mut c, accounts(2));
        testing_env!(ctx(accounts(1)).build());
        c.ft_transfer(accounts(2), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn transfer_to_unregistered_panics() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).attached_deposit(NearToken::from_yoctonear(1)).build());
        c.ft_transfer(accounts(3), U128(1), None);
    }
}
