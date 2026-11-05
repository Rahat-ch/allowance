# The Allowance account is locked and not upgradeable

After setup, the Allowance account holds no full-access key and its contract can't be upgraded. Chain Signatures derives the Payer Account's keys from the Allowance account, so anyone able to act as that account (a full-access key, or an upgrade path that swaps in new code) could sign arbitrary payments from the Payer Account and bypass the Policy, including the Owner or anyone who steals the Owner's keys.

We accept the cost: a bug fix means deploying a new Allowance and withdrawing funds to it, and the Agent's key can only be replaced through an Owner method on the contract. The Payer Account is created by the contract itself with only derived keys, so no person ever holds a key to it.
