# One contract account per Owner and Agent

Each Allowance is its own NEAR contract account (e.g. `allowance.<owner>.testnet`) holding one Owner's funds for exactly one Agent. We did not build one shared contract holding many Allowances, even though that would be closer to a sign-up-and-go product.

Isolation was worth more than scale here. A separate account means one Owner's funds and state can never be touched by a bug or attack involving someone else's Allowance, the Agent's function-call key is scoped to a contract that holds only its own budget, and the contract needs no per-vault accounting. Running several Agents means deploying several Allowances.

## Considered Options

- **Shared contract, many Allowances:** pools everyone's money behind one contract; a single bug has a much larger blast radius.
- **One contract per Owner, many Agents:** needs per-Agent keys, limits and windows inside one contract; more accounting for little demo value.
