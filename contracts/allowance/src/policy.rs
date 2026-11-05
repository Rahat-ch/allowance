//! The Policy: the limits the Owner sets on the Agent's spending.

use near_sdk::json_types::U128;
use near_sdk::{near, require};

/// Longest validity a Signed Payment may be given, in blocks (~1 block per second).
pub const MAX_TIMEOUT_BLOCKS_LIMIT: u64 = 600;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Most that Approved and Pending spends may reserve over any rolling 24 hours.
    pub daily_cap: U128,
    /// Largest spend approved without the Owner.
    pub auto_limit: U128,
    /// Largest single spend allowed at all, even with the Owner's approval.
    pub hard_ceiling: U128,
    /// Most Approved and Pending spends per rolling hour.
    pub velocity_limit: u32,
    /// Longest seller timeout a Signed Payment may be valid for, in blocks.
    pub max_timeout_blocks: u64,
}

impl Policy {
    pub fn assert_valid(&self) {
        require!(self.daily_cap.0 > 0, "daily_cap must be positive");
        require!(self.hard_ceiling.0 > 0, "hard_ceiling must be positive");
        require!(self.velocity_limit > 0, "velocity_limit must be positive");
        require!(self.auto_limit.0 <= self.hard_ceiling.0, "auto_limit must not exceed hard_ceiling");
        require!(self.auto_limit.0 <= self.daily_cap.0, "auto_limit must not exceed daily_cap");
        require!(
            (1..=MAX_TIMEOUT_BLOCKS_LIMIT).contains(&self.max_timeout_blocks),
            "max_timeout_blocks must be 1..=600"
        );
    }
}
