# Pending spends reserve the Daily Cap

A Pending spend counts against the Daily Cap from the moment it is requested, not when the Owner approves it. So while a $15 spend waits, the Agent has only $5 of a $20 cap left, and small spends can be Blocked even though no money has moved yet.

We chose this because it is the only way the cap stays exact. If Pending spends didn't reserve, an Agent could fill the cap with small Approved spends while a large one waits, and the Owner's approval would then either fail or push total spend past the cap. Reserving means an approval can never fail for lack of cap, and no mix of small, split, or retried requests can exceed it. This exactness is Allowance's main difference from existing agent spending policies, so don't "fix" it by counting only Paid spends.

## Consequences

- Pending spends Expire after 24 hours so a forgotten approval can't hold the cap forever.
- A Rejected or Expired spend releases its Reservation. A Signed Payment keeps it for the rest of the window, even if the Payee never collects it, because the Allowance can't observe settlement (see ADR 0003).
- The Owner can only Withdraw funds not held by a Reservation, for the same reason.
