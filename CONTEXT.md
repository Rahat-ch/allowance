# Allowance

Lets a human give an AI agent a budget it can spend under enforced rules, without giving the agent control of the funds.

## Language

### Parties

**Owner**:
The human who funds an Allowance, sets its Policy, and approves or rejects escalated spends. Holds full control and can pause or revoke the Agent at any time.
_Avoid_: Principal, parent, guardian, user

**Agent**:
The AI program that spends from an Allowance. It can only ask to spend; it never holds the funds or the power to move them directly.
_Avoid_: Bot, assistant, client

### Control

**Pause**:
A reversible freeze set by the Owner. While paused, every new Spend Request is Blocked and no Signed Payment is issued. The Owner can still approve or reject Pending spends, but approved ones can't be picked up until unpause.
_Avoid_: Freeze, kill switch

**Revoke**:
The permanent removal of an Agent from its Allowance. All its Pending spends and approved spends not yet picked up are cancelled; Signed Payments already issued stay valid until they expire. Spending again needs a new Allowance.
_Avoid_: Kill, disable

**Withdraw**:
The Owner taking funds back out of an Allowance. Only funds not held by a Reservation can be withdrawn.

### Money

**Allowance**:
One Owner's budget for exactly one Agent, held in its own account and governed by one Policy. Denominated in a single stablecoin.
_Avoid_: Vault, wallet, budget account

**Daily Cap**:
The most the Agent may spend in any rolling 24-hour period. It is never a calendar day; it does not reset at midnight.
_Avoid_: Daily limit, daily budget

**Auto Limit**:
The largest single spend that goes through without the Owner's approval.
_Avoid_: Per-tx limit, threshold

**Hard Ceiling**:
The largest single spend the Agent may request at all, even with approval. Anything above it is Blocked.
_Avoid_: Max spend, hard cap

**Payee**:
An account the Agent wants to pay. The Agent can only pay Payees on the Allowlist.
_Avoid_: Recipient, receiver, merchant

**Allowlist**:
The Payees the Owner has approved. Only the Owner can change it; the Agent cannot add to it by asking. Removing a Payee rejects every Pending spend to them.
_Avoid_: Whitelist

**Policy**:
The full set of rules an Allowance enforces: Daily Cap, Auto Limit, Hard Ceiling, Allowlist, and the other limits.
_Avoid_: Rules, config, settings

### Spending

**Spend Request**:
The Agent's ask to pay a Payee a specific amount. Every Spend Request gets exactly one Outcome.
_Avoid_: Payment, transaction, spend attempt

**Outcome**:
The verdict on a Spend Request: Approved, Pending, or Blocked.

**Approved**:
The Spend Request is within Policy and at most the Auto Limit, so a Signed Payment is issued immediately.

**Pending**:
The Spend Request is within Policy but above the Auto Limit, so it waits for the Owner to approve or reject it. It holds a Reservation while it waits, and Expires after 24 hours without a decision. Once approved, the Agent has 1 hour to pick up its Signed Payment.
_Avoid_: Escalated, held, queued

**Rejected**:
A Pending spend the Owner turned down. Its Reservation is released.

**Expired**:
A Pending spend nobody decided on within 24 hours. Treated like Rejected.

**Lapsed**:
An approved spend whose Signed Payment the Agent didn't pick up within 1 hour of approval. Its Reservation is released and it can no longer be paid.

**Pickup**:
The Agent collecting the Signed Payment for a spend the Owner approved, by re-submitting the same Request ID. Refused while Paused.
_Avoid_: Claim, redeem

**Reservation**:
The amount set aside against the Daily Cap the moment a spend is Approved or Pending, before any money moves. A Rejected, Expired or Lapsed spend releases it; a Signed Payment keeps it for a full window from the moment it is issued, even if the signature never arrives. Reservations are what stop many small requests from slipping past the cap together.
_Avoid_: Hold, lock

**Risk Check**:
An independent review of a Spend Request that can only escalate it: a flagged spend that would be Approved becomes Pending. It can never approve or block anything.

**Request ID**:
The Agent's own identifier for a Spend Request. It is bound forever to its first amount and Payee: an identical retry gets back the request's current state and the same Signed Payment, so it never pays twice (this is also how Pickup works), and a retry with different details is refused as a conflict.
_Avoid_: Nonce, idempotency key

**Signed Payment**:
The exact, ready-to-submit x402 payment the Allowance builds and signs for an approved spend: this amount, to this Payee, valid for a short time. The Agent hands it to the Payee, who collects it. It counts as spent the moment it is issued, whether or not the Payee ever collects it. It is the only way money leaves an Allowance to a Payee.
_Avoid_: Payment authorization, voucher, receipt

**Payer Account**:
The account Signed Payments draw from. Only the Allowance can sign for it; neither the Agent nor the Owner holds its key.
_Avoid_: Hot wallet, spending account

**Sweep**:
The Owner bringing USDC back from the Payer Account that Signed Payments left there uncollected, once they have expired. The Allowance signs it like a Signed Payment (back to itself) and anyone can submit it; the returned USDC becomes Withdrawable. Swept Signed Payments still count against the Daily Cap: only the funds come back.
_Avoid_: Refund, reclaim

**Velocity Limit**:
The most Spend Requests the Agent may have Approved or Pending in any rolling hour. Blocked requests don't count.
_Avoid_: Rate limit

**Blocked**:
The Spend Request breaks the Policy and will never be paid, whatever the Agent or Owner does with it.
_Avoid_: Rejected, which is reserved for an Owner turning down a Pending spend
