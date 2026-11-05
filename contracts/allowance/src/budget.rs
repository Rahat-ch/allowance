//! Exact rolling limits (ADR 0001).
//!
//! Time is cut into hourly buckets keyed by absolute hour (block timestamp / 1h).
//! - **Daily Cap:** every Approved or Pending spend reserves its amount in a bucket the
//!   moment it is requested. The window is the current bucket and the 24 before it, so a
//!   spend counts for 24-25 hours: bucket `b` leaves the window when hour `b + 25` starts.
//!   (With only 24 buckets a spend at 00:59 would leave at 24:00, 23 hours later.) A Reservation is
//!   released when a spend ends without money leaving (Rejected, Expired, Lapsed, failed
//!   funding) and moved to the issue hour's bucket when its Signed Payment is issued.
//! - **Velocity Limit:** Approved and Pending spends are counted in their request hour's
//!   bucket; the window is the current and previous bucket. Counts are never released.

use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::store::LookupMap;

pub const HOUR_NS: u64 = 3_600_000_000_000;
/// Buckets in the Daily Cap window: this hour and the 24 before it.
pub const DAY_BUCKETS: u64 = 25;
/// Buckets in the Velocity window: this hour and the one before it.
pub const VELOCITY_BUCKETS: u64 = 2;

pub fn hour_of(timestamp_ns: u64) -> u64 {
    timestamp_ns / HOUR_NS
}

/// When a limit that's full now has room for `needed` more.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Shortfall {
    pub used: u128,
    pub limit: u128,
    /// Block timestamp (ns) from which it fits; None if it never can (bigger than the limit).
    pub retry_after_ns: Option<u64>,
}

#[near(serializers = [borsh])]
pub struct Budget {
    reserved: LookupMap<u64, u128>,
    counts: LookupMap<u64, u32>,
}

/// What the Daily Cap looks like right now.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CapUsage {
    /// Reserved in the current window: Pending, approved-unsigned and issued Signed Payments.
    pub used_in_window: U128,
    pub daily_cap: U128,
    pub available: U128,
    /// When the oldest Reservation in the window leaves it; None if nothing is reserved.
    pub next_release_ns: Option<u64>,
    pub velocity_used: u32,
    pub velocity_limit: u32,
}

impl Budget {
    pub fn new(reserved_prefix: &[u8], counts_prefix: &[u8]) -> Self {
        Self { reserved: LookupMap::new(reserved_prefix.to_vec()), counts: LookupMap::new(counts_prefix.to_vec()) }
    }

    fn reserved_in(&self, hour: u64) -> u128 {
        self.reserved.get(&hour).copied().unwrap_or(0)
    }

    fn count_in(&self, hour: u64) -> u32 {
        self.counts.get(&hour).copied().unwrap_or(0)
    }

    /// Hours of the Daily Cap window ending at `now_hour`, oldest first.
    fn day_window(now_hour: u64) -> impl Iterator<Item = u64> {
        now_hour.saturating_sub(DAY_BUCKETS - 1)..=now_hour
    }

    pub fn used_in_window(&self, now_hour: u64) -> u128 {
        Self::day_window(now_hour).map(|h| self.reserved_in(h)).sum()
    }

    pub fn velocity_used(&self, now_hour: u64) -> u32 {
        (now_hour.saturating_sub(VELOCITY_BUCKETS - 1)..=now_hour).map(|h| self.count_in(h)).sum()
    }

    /// Err if `amount` more would exceed the Daily Cap now.
    pub fn check_cap(&self, now_hour: u64, amount: u128, cap: u128) -> Result<(), Shortfall> {
        let used = self.used_in_window(now_hour);
        if used.saturating_add(amount) <= cap {
            return Ok(());
        }
        // Walk the window oldest first: bucket `h` leaves it at the start of hour h + 25.
        // A best estimate: a Pending or approved-unsigned Reservation moves forward to the
        // hour its Signed Payment is issued, which can make the real time later.
        let retry_after_ns = if amount > cap {
            None
        } else {
            let mut still_used = used;
            Self::day_window(now_hour).find_map(|h| {
                still_used -= self.reserved_in(h);
                (still_used.checked_add(amount)? <= cap).then(|| (h + DAY_BUCKETS) * HOUR_NS)
            })
        };
        Err(Shortfall { used, limit: cap, retry_after_ns })
    }

    /// Err if one more Approved or Pending spend would exceed the Velocity Limit now.
    pub fn check_velocity(&self, now_hour: u64, limit: u32) -> Result<(), Shortfall> {
        let used = self.velocity_used(now_hour);
        if used < limit {
            return Ok(());
        }
        // The previous hour's count drops out at the start of the next hour.
        let retry_after_ns = if limit == 0 {
            None
        } else if self.count_in(now_hour) < limit {
            Some((now_hour + 1) * HOUR_NS)
        } else {
            Some((now_hour + VELOCITY_BUCKETS) * HOUR_NS)
        };
        Err(Shortfall { used: used as u128, limit: limit as u128, retry_after_ns })
    }

    /// Records an Approved or Pending spend: reserves it and counts it for Velocity.
    pub fn reserve(&mut self, hour: u64, amount: u128) {
        *self.reserved.entry(hour).or_insert(0) += amount;
        *self.counts.entry(hour).or_insert(0) += 1;
    }

    /// Gives back a Reservation (Velocity is never given back).
    pub fn release(&mut self, hour: u64, amount: u128) {
        let left = self.reserved_in(hour).saturating_sub(amount);
        if left == 0 {
            self.reserved.remove(&hour);
        } else {
            self.reserved.insert(hour, left);
        }
    }

    /// Moves a Reservation to the hour its Signed Payment was issued in, so it counts for a
    /// full window from issue. Callers must only move Reservations still in the window
    /// (Pending Expires and approvals are re-bucketed before their bucket can leave it).
    pub fn rebucket(&mut self, from_hour: u64, to_hour: u64, amount: u128) {
        if from_hour != to_hour {
            self.release(from_hour, amount);
            *self.reserved.entry(to_hour).or_insert(0) += amount;
        }
    }

    pub fn usage(&self, now_hour: u64, daily_cap: u128, velocity_limit: u32) -> CapUsage {
        let used = self.used_in_window(now_hour);
        CapUsage {
            used_in_window: U128(used),
            daily_cap: U128(daily_cap),
            available: U128(daily_cap.saturating_sub(used)),
            next_release_ns: Self::day_window(now_hour)
                .find(|&h| self.reserved_in(h) > 0)
                .map(|h| (h + DAY_BUCKETS) * HOUR_NS),
            velocity_used: self.velocity_used(now_hour),
            velocity_limit,
        }
    }
}
