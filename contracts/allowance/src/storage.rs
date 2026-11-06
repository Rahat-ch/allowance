//! Storage griefing protection.
//!
//! Every stored Spend Request costs this account NEAR for storage staking, and the Agent
//! decides how many it submits. Approved and Pending requests are bounded by the Velocity
//! Limit, but Blocked ones (an unknown Payee, say) aren't bounded by anything else, so an
//! Agent could flood them until the Allowance's NEAR is all staked for storage and the
//! Owner's own calls fail. So at most `BLOCKED_RECORDS_PER_HOUR` Blocked requests are
//! stored per hour; beyond that the NEP-297 event (with `"stored": false`) is the only
//! record.
//!
//! The budget keeps only the current hour and its count, so it never grows itself.

use near_sdk::near;

/// Blocked requests stored per hour. A stored Blocked request with a maximal Request ID and
/// memo takes ~611 bytes (measured in the sandbox), ~0.006 NEAR of storage staking, so 20 an
/// hour caps a flood at ~0.12 NEAR an hour (~2.9 NEAR a day), while an honest Agent, which
/// is rarely Blocked, keeps a full on-chain record.
pub const BLOCKED_RECORDS_PER_HOUR: u32 = 20;

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct BlockedRecords {
    hour: u64,
    stored: u32,
}

impl BlockedRecords {
    /// Whether a Blocked request submitted in `hour` may be stored; counts it if so.
    pub fn admit(&mut self, hour: u64) -> bool {
        if hour != self.hour {
            self.hour = hour;
            self.stored = 0;
        }
        if self.stored >= BLOCKED_RECORDS_PER_HOUR {
            return false;
        }
        self.stored += 1;
        true
    }
}
