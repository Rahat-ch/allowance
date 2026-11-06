//! Funding and Withdraw: where the Allowance's USDC is.
//!
//! The contract keeps its own ledger of the USDC it holds instead of asking the token, so
//! every view is synchronous:
//! - **USDC balance** goes up on a deposit (`ft_on_transfer` from the configured asset) and
//!   down the moment a transfer out starts (into the Payer Account, or a Withdraw). A
//!   transfer that fails puts it back.
//! - **Held** = Pending + approved-unsigned amounts: committed to a spend whose money hasn't
//!   left yet. Money moving into the Payer Account (Funding) is already off the balance, so
//!   it is not held, and funds behind issued Signed Payments are never counted twice.
//! - **Withdrawable** = USDC balance − Held: Held limits what the Owner can take out, so
//!   the Owner can never Withdraw money a Pending or approved spend is counting on.
//!   Spends themselves only need the balance to cover them (the spec defines Held for
//!   Withdraw only). If spends outrun the balance, the later one fails funding, releases
//!   its Reservation, and the Owner tops up.
//!
//! USDC sent with a plain `ft_transfer` (no notify) isn't credited and can't be spent or
//! withdrawn; always fund with `ft_transfer_call`.
//!
//! # Lifecycle hooks
//!
//! Every Spend Request that gets a Reservation is also held, and leaves Held exactly once:
//!
//! | Transition                                        | Call                         |
//! |---------------------------------------------------|------------------------------|
//! | Approved or Pending (Reservation made)            | [`Funds::hold`]              |
//! | Pending → approved-unsigned (Owner approves)      | nothing (stays held)         |
//! | Rejected / Expired / Lapsed / cancelled by Revoke | [`Funds::unhold`]            |
//! | Approved or picked up → Funding                   | [`Funds::fund_payer`]        |
//! | Funding → FundingFailed                           | [`Funds::restore`]           |
//! | Funding → Signing / Signed / SignatureUnavailable | nothing (the money has left) |

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, near, require};

use crate::budget::CapUsage;
use crate::{Allowance, AllowanceExt, events, ext_ft};

const WITHDRAW_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const ON_WITHDRAWN_GAS: Gas = Gas::from_tgas(10);

/// The Allowance's USDC ledger and what is Held from it.
#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Funds {
    balance: u128,
    held: u128,
}

impl Funds {
    pub fn balance(&self) -> u128 {
        self.balance
    }

    pub fn held(&self) -> u128 {
        self.held
    }

    /// USDC balance − Held (never below zero: Pending spends can hold more than is there).
    pub fn withdrawable(&self) -> u128 {
        self.balance.saturating_sub(self.held)
    }

    /// Credits USDC that arrived, or that came back from a failed transfer out.
    pub fn restore(&mut self, amount: u128) {
        self.balance += amount;
    }

    /// A spend got a Reservation (Approved or Pending): hold its amount.
    pub fn hold(&mut self, amount: u128) {
        self.held += amount;
    }

    /// A held spend ended without money leaving (Rejected, Expired, Lapsed, Revoked).
    pub fn unhold(&mut self, amount: u128) {
        self.held = self.held.saturating_sub(amount);
    }

    /// A held spend starts moving its amount into the Payer Account. Always drops the hold;
    /// takes the amount off the balance and returns true if the balance covers it,
    /// otherwise takes nothing and returns false (the spend can't be funded).
    #[must_use]
    pub fn fund_payer(&mut self, amount: u128) -> bool {
        self.unhold(amount);
        if amount > self.balance {
            return false;
        }
        self.balance -= amount;
        true
    }

    /// Takes `amount` off the balance if it is Withdrawable (for Withdraw).
    fn take(&mut self, amount: u128) -> bool {
        if amount > self.withdrawable() {
            return false;
        }
        self.balance -= amount;
        true
    }
}

/// The budget view: Daily Cap usage plus where the money is.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetView {
    #[serde(flatten)]
    pub cap: CapUsage,
    /// USDC the Allowance holds (credited deposits, less transfers out).
    pub usdc_balance: U128,
    /// Pending + approved-unsigned amounts.
    pub held: U128,
    /// USDC balance − Held: what the Owner may Withdraw.
    pub withdrawable: U128,
    /// The Allowance account's NEAR, for storage, signing deposits and gas.
    pub near_balance: NearToken,
}

#[near]
impl Allowance {
    /// NEP-141 transfer-and-notify receiver. Credits USDC from the configured asset; any
    /// other token is refused by returning the whole amount as unused, so its contract
    /// refunds the sender. Anyone may deposit: it only adds funds.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        if env::predecessor_account_id() != self.asset_id {
            env::log_str("only the Allowance's asset is accepted; refunding");
            return PromiseOrValue::Value(amount);
        }
        self.funds.restore(amount.0);
        events::emit(
            "deposit",
            json!({ "sender_id": sender_id, "amount": amount, "usdc_balance": U128(self.funds.balance()) }),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Owner only, with exactly 1 yoctoNEAR attached (so it needs a full-access key or a
    /// wallet confirmation, never a function-call key a web page signed in with): sends up
    /// to the Withdrawable USDC to the Owner. If the transfer fails, the amount comes back
    /// to the balance.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "amount must be positive");
        let withdrawable = self.funds.withdrawable();
        if !self.funds.take(amount.0) {
            env::panic_str(&format!(
                "amount exceeds Withdrawable: {} requested, {} withdrawable ({} balance, {} held)",
                amount.0,
                withdrawable,
                self.funds.balance(),
                self.funds.held()
            ));
        }
        let receiver_id = self.owner_id.clone();
        ext_ft::ext(self.asset_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(WITHDRAW_TRANSFER_GAS)
            .ft_transfer(receiver_id.clone(), amount, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_WITHDRAWN_GAS).on_withdrawn(receiver_id, amount))
    }

    #[private]
    pub fn on_withdrawn(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> bool {
        let event = if sent.is_ok() {
            "withdraw"
        } else {
            self.funds.restore(amount.0);
            "withdraw_failed"
        };
        events::emit(
            event,
            json!({ "receiver_id": receiver_id, "amount": amount, "usdc_balance": U128(self.funds.balance()) }),
        );
        sent.is_ok()
    }
}

impl Allowance {
    pub(crate) fn budget_view(&self, cap: CapUsage) -> BudgetView {
        BudgetView {
            cap,
            usdc_balance: U128(self.funds.balance()),
            held: U128(self.funds.held()),
            withdrawable: U128(self.funds.withdrawable()),
            near_balance: env::account_balance(),
        }
    }
}
