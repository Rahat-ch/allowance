//! Shared test helpers.

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{NearToken, env, testing_env};

/// Keeps the current mocked call (who, where, when) but attaches 1 yoctoNEAR, as the
/// Owner's wallet does to confirm a sensitive call.
pub fn confirm() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(env::current_account_id())
        .predecessor_account_id(env::predecessor_account_id())
        .signer_account_id(env::signer_account_id())
        .block_height(env::block_height())
        .block_timestamp(env::block_timestamp())
        .account_balance(env::account_balance())
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
}
