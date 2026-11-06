# Owner web page

A static single-page app (Vite + React + TypeScript) where the Owner of an Allowance signs
in with their NEAR wallet and:

- sees every Pending spend (amount, Payee, memo, request time, time until Expiry) and
  approved spends waiting for Pickup (time until the Pickup deadline);
- approves or rejects Pending spends;
- Pauses, unpauses or Revokes the Agent;
- watches the Budget: used in the rolling 24 hours (Reservations included), available,
  when capacity frees, Velocity, USDC balance, Held, Withdrawable and NEAR balance.

The page refreshes every 5 seconds and after every action. No server holds a key: every
Owner call is signed in the Owner's wallet. `approve`, `reject`, `unpause` and `revoke`
attach exactly 1 yoctoNEAR, so the wallet always asks for a confirmation. `pause` attaches
nothing, so the key a wallet creates at sign-in (limited to `pause` on this Allowance) can
stop the Agent without a confirmation. Controls are enabled only when the signed-in
account is the Allowance's Owner (`get_owner`).

## Run it

```sh
pnpm --filter web dev        # http://localhost:5173
pnpm --filter web build      # static files in packages/web/dist
pnpm --filter web preview    # serve dist locally
```

`dist/` uses relative asset paths, so it can be served from any static host and path.

### Which Allowance

The bar at the top picks the network (testnet by default, mainnet, or a local sandbox),
the RPC (FastNEAR by default) and the Allowance account. The page remembers them in this
browser and in the URL, so a link carries them:

```
http://localhost:5173/?allowance=allowance.owner.testnet
http://localhost:5173/?network=mainnet&allowance=…
http://localhost:5173/?network=sandbox&rpc=http://127.0.0.1:3030&allowance=…
```

### Against testnet

Open `?allowance=<your Allowance>.testnet` and sign in with MyNearWallet, Meteor or Intear
as the Owner account the Allowance was initialized with.

### Against a local sandbox

Wallets can't reach a local chain, so on the `sandbox` network the page offers a sandbox
sign-in with a pasted secret key instead (never shown on testnet or mainnet).

```sh
pnpm --filter web sandbox    # terminal 1: sandbox + Allowance + some Spend Requests
pnpm --filter web dev        # terminal 2
```

The sandbox script builds the contracts, starts the harness from `packages/sandbox`,
submits a $5 Approved spend and two Pending spends ($150, $120), adds a fresh full-access
key to the Owner account, and prints the page URL plus the Owner account and key to paste
into the sandbox sign-in. Press Enter in its terminal to submit another Pending spend;
Ctrl+C stops it. Set `PAGE_URL` if the dev server runs elsewhere.

## Layout

- `src/allowance.ts`: the data layer. View calls over JSON-RPC (`AllowanceViews`), the
  Owner calls the page sends (`ownerCalls`: method, args, gas, deposit), and
  `explainError`, which turns contract panics ("request already decided", "request
  expired", …) into plain sentences. No UI or wallet code.
- `src/format.ts`: USDC base units as dollars, NEAR, durations and countdowns.
- `src/config.ts`: network, RPC and Allowance from the URL or this browser's memory.
- `src/wallet.ts`: wallet sign-in through `@near-wallet-selector`, and the sandbox key.
- `src/ui/`: React components. Management (Policy, Allowlist, Withdraw, Agent key, recent
  Spend Requests; #15) slots into `App.tsx` below the Control panel and adds its calls
  to `ownerCalls`.

## Tests

```sh
pnpm --filter web test        # unit + sandbox (builds the contracts, starts a sandbox)
pnpm --filter web test:unit   # formatting, Owner call builders, error messages, config
```

The sandbox test (`test/views.sandbox.test.ts`) runs the data layer's views against the
real contract and sends the page's Owner calls with the Owner's key, so view parsing and
the builders are checked against what the Allowance actually does.

## Wallet notes

- Wallet modules: MyNearWallet, Meteor and Intear (`@near-wallet-selector` 10.1.4). HOT's
  module is left out: its SDK pulls in an old wallet-selector core that wants near-api-js
  4 or 5.
- Meteor's SDK imports `utils` from near-api-js, which v7 removed, so this package depends
  on near-api-js 6.5.1 to satisfy Meteor's peer dependency. The page's own code uses
  `@near-js/*` 2.x, not near-api-js. Meteor also expects Node's `global`, `Buffer` and
  `process`; `src/polyfills.ts` provides them.
