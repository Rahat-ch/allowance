# x402 payments are signed by the contract via Chain Signatures

Allowance must pay any standard x402 seller on NEAR through the official `exact` scheme, unmodified. That scheme only accepts a NEP-366 signed delegate containing a single `ft_transfer`, signed by a **full-access** key of the payer. The Agent's function-call key can't produce one: NEAR rejects deposits from function-call keys, and the spec says function-call keys "MUST be rejected" ([scheme_exact_near.md](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_near.md)).

So the Allowance contract controls a full-access key on a dedicated Payer Account through NEAR Chain Signatures (MPC). Only after a Spend Request passes Policy (Approved, or Pending then approved by the Owner) does the contract build the exact `ft_transfer` delegate itself (asset, Payee, amount, nonce, short expiry) and request the MPC signature. The Agent receives the Signed Payment and passes it to the seller as `PAYMENT-SIGNATURE`. Sellers and facilitators see an ordinary x402 payment.

## Considered Options

- **Agent holds a key to a hot payer account, topped up per approved spend:** works with x402 but the Agent could send the money anywhere, so the Payee allowlist would only be advisory. Rejected because it breaks the core guarantee.
- **A new "allowance" x402 scheme verified by facilitators:** keeps every guarantee but no standard seller would accept it.
- **Also keeping a direct contract-to-Payee transfer path:** dropped to keep one payment path to build and test.

## Consequences

- The contract must never sign a payload the Agent supplies, only delegates it built from an approved request.
- Once a payment is sent to the signer it counts as spent whatever happens: signer nodes publish signatures in public transactions, so a "failed" or late signature may still be usable by anyone.
- The Allowance account must hold no full-access key, since whoever controls it could request signatures for the Payer Account (ADR 0004).
- The Allowance can't see whether a Signed Payment was collected, so a Signed Payment counts as spent for the rest of the window. Short expiry limits the waste.
- Concurrent Signed Payments from one key would invalidate each other's nonces, so the Payer Account uses a pool of derived keys.
- The token is Circle USDC (testnet), because standard facilitators only accept it.
