//! The Payer Account's signing key pool.
//!
//! Two outstanding Signed Payments from one key would invalidate each other: whichever
//! settles first raises the key's on-chain nonce past the other's (ADR 0003). So every
//! outstanding Signed Payment leases one derived key of its own:
//!
//! 1. `lease` when a spend is about to be issued (Approved, or picked up), before any money
//!    moves. A request holds at most one lease; leasing again returns the same key.
//! 2. `release` if the transfer into the Payer Account fails: nothing was signed.
//! 3. `issue` once funded: fixes the payment's nonce and `max_block_height` and keeps the
//!    lease until that height has passed, whatever the signer does (a late signature is
//!    still usable until then).
//!
//! A key is free again once the chain is past its payment's `max_block_height`, because
//! NEAR refuses a delegate whose `max_block_height` is below the current block.
//!
//! Sweeps (see `sweep`) lease keys the same way, under the holder id `sweep:<id>`, so a
//! sweep only ever signs with a key whose Signed Payment has expired, and its higher nonce
//! also invalidates any older delegate on that key.

use near_sdk::near;

/// One Payer Account key: path `x402/<index>`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct PayerKey {
    public_key: [u8; 32],
    /// Highest delegate nonce issued with this key, across all its leases.
    last_nonce: u64,
    lease: Option<Lease>,
    /// Delegates issued with this key that may still move money: until
    /// `SETTLEMENT_SLACK_BLOCKS` past their `max_block_height`. Kept apart from the lease,
    /// which the next holder overwrites as soon as the key is free.
    recent: Vec<IssuedTo>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct IssuedTo {
    holder: String,
    max_block_height: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Lease {
    request_id: String,
    /// The payment's `max_block_height`; None while it is still being funded.
    until: Option<u64>,
    /// While funding: the height after which the lease is abandoned. Funding takes a few
    /// blocks; this only matters if the funding callback itself failed, which would
    /// otherwise lose the key for good (the account is locked, so nothing could free it).
    funding_deadline: u64,
}

/// Blocks a lease may wait on its funding callback before the key is reclaimed.
pub const FUNDING_LEASE_BLOCKS: u64 = 1_000;

/// Blocks of slack between the issuing block and the facilitator's final block: the nonce
/// is taken this far below the issuing height and the validity ends this much sooner, so
/// the facilitator's `nonce < final_height x 1e6` and `max_block_height - final_height <=
/// maxTimeoutSeconds` checks hold even if it verifies before the issuing block is final.
pub const FINALITY_SLACK_BLOCKS: u64 = 2;

/// Blocks past a delegate's `max_block_height` during which the transfer it started may
/// still be in flight: NEAR checks `max_block_height` when the Delegate action executes,
/// and the token transfer it emits runs a block or more later (cross-shard). A sweep keeps
/// deducting such a delegate's amount until then.
pub const SETTLEMENT_SLACK_BLOCKS: u64 = 40;

impl PayerKey {
    fn is_free(&self, height: u64) -> bool {
        match &self.lease {
            None => true,
            Some(Lease { until: Some(until), .. }) => height > *until,
            Some(Lease { until: None, funding_deadline, .. }) => height > *funding_deadline,
        }
    }
}

/// What a fixed Signed Payment gets from the pool.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Issued {
    pub key_index: u32,
    pub nonce: u64,
    pub max_block_height: u64,
}

/// The pool as the Owner and Agent see it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyPoolStatus {
    /// Derived keys on the Payer Account.
    pub keys: u32,
    /// Keys a new Signed Payment could lease right now.
    pub free: u32,
    /// Lowest block height at which a leased key frees up; None if a key is free now or
    /// every lease is still waiting on its funding.
    pub next_free_height: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct KeyPool {
    keys: Vec<PayerKey>,
}

impl KeyPool {
    pub fn new(public_keys: Vec<[u8; 32]>) -> Self {
        Self {
            keys: public_keys.into_iter().map(|public_key| PayerKey { public_key, last_nonce: 0, lease: None, recent: Vec::new() }).collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn public_keys(&self) -> impl Iterator<Item = &[u8; 32]> {
        self.keys.iter().map(|k| &k.public_key)
    }

    pub fn public_key(&self, key_index: u32) -> [u8; 32] {
        self.keys[key_index as usize].public_key
    }

    /// The key leased to `request_id`, if any.
    pub fn leased_to(&self, request_id: &str) -> Option<u32> {
        self.keys
            .iter()
            .position(|k| k.lease.as_ref().is_some_and(|l| l.request_id == request_id))
            .map(|i| i as u32)
    }

    /// Leases a free key to `request_id` (or returns the one it already holds). None when
    /// every key is in use: the caller must refuse the spend before changing anything.
    pub fn lease(&mut self, request_id: &str, height: u64) -> Option<u32> {
        if let Some(k) = self.leased_to(request_id) {
            return Some(k);
        }
        let k = self.keys.iter().position(|k| k.is_free(height))?;
        self.keys[k].lease = Some(Lease {
            request_id: request_id.to_string(),
            until: None,
            funding_deadline: height + FUNDING_LEASE_BLOCKS,
        });
        Some(k as u32)
    }

    /// Gives back `request_id`'s key before anything was signed with it.
    pub fn release(&mut self, request_id: &str) {
        if let Some(k) = self.leased_to(request_id) {
            self.keys[k as usize].lease = None;
        }
    }

    /// Fixes the Signed Payment for `request_id` at `height`: valid for `timeout_blocks`
    /// blocks, and its key stays leased until then. Panics if it holds no lease.
    ///
    /// Nonce: NEAR wants it above the key's on-chain nonce (a key starts at about its
    /// creation height x 1e6) and below the facilitator's final height x 1e6. A block range
    /// a little below the current one, `(height - 1 - slack) x 1e6`, satisfies both (the
    /// `height - 1` form is proven on testnet, docs/notes/chain-signatures.md); the per-key
    /// sequence keeps it rising across leases. The validity ends `slack` blocks early too.
    pub fn issue(&mut self, request_id: &str, height: u64, timeout_blocks: u64) -> Issued {
        let k = self.leased_to(request_id).expect("no signing key leased for this request");
        let key = &mut self.keys[k as usize];
        let nonce = (height.saturating_sub(1 + FINALITY_SLACK_BLOCKS) * 1_000_000).max(key.last_nonce + 1);
        let max_block_height = height + timeout_blocks.saturating_sub(FINALITY_SLACK_BLOCKS).max(1);
        key.last_nonce = nonce;
        key.lease = Some(Lease { request_id: request_id.to_string(), until: Some(max_block_height), funding_deadline: 0 });
        key.recent.retain(|r| r.holder != request_id && height <= r.max_block_height.saturating_add(SETTLEMENT_SLACK_BLOCKS));
        key.recent.push(IssuedTo { holder: request_id.to_string(), max_block_height });
        Issued { key_index: k, nonce, max_block_height }
    }

    /// Who may still move money out of the Payer Account at `height`, each once: leases
    /// still funding (their amount is on its way in), and every delegate issued until
    /// `SETTLEMENT_SLACK_BLOCKS` past its `max_block_height`, even if its key has been
    /// leased again since.
    pub fn live_holders(&self, height: u64) -> impl Iterator<Item = &str> {
        self.keys.iter().flat_map(move |k| {
            let funding = k
                .lease
                .as_ref()
                .filter(|l| l.until.is_none() && height <= l.funding_deadline)
                .map(|l| l.request_id.as_str());
            let issued = k
                .recent
                .iter()
                .filter(move |r| height <= r.max_block_height.saturating_add(SETTLEMENT_SLACK_BLOCKS))
                .map(|r| r.holder.as_str());
            funding.into_iter().chain(issued)
        })
    }

    pub fn status(&self, height: u64) -> KeyPoolStatus {
        let free = self.keys.iter().filter(|k| k.is_free(height)).count() as u32;
        let next_free_height = if free > 0 {
            None
        } else {
            self.keys.iter().filter_map(|k| k.lease.as_ref()?.until).min().map(|until| until + 1)
        };
        KeyPoolStatus { keys: self.keys.len() as u32, free, next_free_height }
    }
}
