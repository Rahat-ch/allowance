# allowance-mcp

An MCP server that lets an Agent pay x402 sellers on NEAR through its Allowance, in one tool call. It holds only the Agent's function-call key, which can call nothing but `request_spend` on the Allowance. Every payment is a Spend Request that the contract approves, holds for the Owner (Pending) or blocks. The Signed Payment the seller receives is built and signed by the contract, never by this server.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `allowance_pay` | `url`, `method` (default `GET`), `body?`, `headers?`, `max_usd`, `request_id?`, `memo?` | Calls the URL. On a 402 it picks the offer, submits the Spend Request, waits for the Signed Payment, retries with `PAYMENT-SIGNATURE`, and returns the seller's response |
| `allowance_resume` | `request_id`, `url`, `method`, `body?`, `headers?` | Continues an existing Spend Request. Use it for Pickup after the Owner approves, or after an uncertain result. It never creates a new request |
| `allowance_get_request` | `request_id` | Shows a Spend Request's Outcome, status, amount, Payee, expiry and pickup deadline. The Signed Payment bytes are left out |
| `allowance_get_budget` | none | Shows the Daily Cap, how much is used (Reservations included), what's available and when capacity frees up, Velocity, Auto Limit, Hard Ceiling, USDC balance and the Allowlist |

**`max_usd` is in US dollars**, as a string (`"0.50"`) or a number (`0.5`), with at most 6 decimals. It converts exactly to USDC base units ($1 = 1,000,000). Dollars are what an Agent reasons in, and a 6-decimal string never rounds. Every amount in a result appears both ways, e.g. `amount: "500000"` and `amount_usd: "$0.50"`.

**Offer selection.** `allowance_pay` only pays an x402 `exact` offer that meets all of these:

- it is on the Allowance's network (`ALLOWANCE_NETWORK`);
- its `asset` is the Allowance's asset, read from the contract's `get_asset` view;
- its amount is at most `max_usd`;
- when resuming, it has the request's own Payee and amount.

If several offers qualify, it pays the cheapest. Otherwise it returns `refused` with a reason (`NoMatchingOffer`, `AssetMismatch`, `OverMaxAmount` or `RequestMismatch`) and the offers it saw. No Spend Request is made. The Policy itself (Allowlist, caps, Hard Ceiling) is enforced by the contract, not here.

The Spend Request's `max_timeout_blocks` is the seller's `maxTimeoutSeconds`, at about 1 block per second. The contract clamps it to the Policy maximum. The tool then polls `get_request` until the request is `Signed` or terminal (default wait 90 s). It doesn't rely on one long transaction.

### Results

Every result is JSON with a `result` tag. Results marked "error" come back with `isError: true` and the same structured content.

| `result` | Error | Meaning |
|---|---|---|
| `paid` | | 2xx from the seller. Includes `request_id`, amount, `http_status`, `content_type`, `body` (cut at 8,000 characters, `body_truncated`) and `settlement` (the decoded `PAYMENT-RESPONSE`) |
| `no_payment_required` | | The seller didn't ask for payment |
| `pending` | | Above the Auto Limit. Includes `request_id` and `expires_at`. Call `allowance_resume` after the Owner approves |
| `blocked` | yes | Includes `reason` (UnknownPayee, OverHardCeiling, DailyCapExceeded, VelocityExceeded, Paused, Revoked, IdempotencyConflict, InvalidRequest). DailyCapExceeded and VelocityExceeded also carry `used`, `limit` and `retry_after` |
| `refused` | yes | No acceptable offer. Nothing was requested |
| `busy` | yes | Every signing key is leased. Nothing was stored or reserved. `retryable: true`: retry with the **same** `request_id` |
| `in_progress` | yes | The Signed Payment hadn't arrived when the wait ended. Call `allowance_resume` later |
| `pickup_refused` | yes | The approved spend can't be picked up now (`reason: Paused`, which is retryable, or `Revoked`, `UnknownPayee`, `OverHardCeiling`) |
| `not_paid` | yes | Rejected, Expired, Lapsed, Cancelled, FundingFailed or SignatureUnavailable |
| `payment_not_accepted` | yes | The seller refused the Signed Payment (`seller_error`). It still counts as spent until it expires. `allowance_resume` re-sends the same Signed Payment |
| `unknown_request` | yes | No such request on chain |
| `error` | yes | Something failed after a Spend Request may have been made. Check it with `allowance_get_request` |

The tool descriptions tell the Agent never to use a new Request ID for a payment whose fate is uncertain. A new ID is a new payment. Check the old one with `allowance_get_request` and continue it with `allowance_resume`. If you omit `request_id`, `allowance_pay` generates one and returns it. Passing your own makes retries safe: re-using an existing ID continues that request with its original Payee, amount and memo.

## Configuration

| Variable | Default | |
|---|---|---|
| `ALLOWANCE_ACCOUNT_ID` | required | The Allowance contract account |
| `ALLOWANCE_AGENT_KEY_FILE` | | A near-cli credential file (`{"private_key": "ed25519:..."}`) or a file holding just `ed25519:...`. It must be outside this repository (refused otherwise); `chmod 600` it |
| `ALLOWANCE_AGENT_KEY` | | The key itself, instead of the file |
| `ALLOWANCE_NETWORK` | `near:testnet` | `near:testnet` or `near:mainnet` (`testnet`/`mainnet` also work) |
| `NEAR_RPC_URL` | FastNEAR | `https://test.rpc.fastnear.com` on testnet, `https://rpc.mainnet.fastnear.com` on mainnet |
| `ALLOWANCE_SIGN_TIMEOUT_MS` | `90000` | How long `allowance_pay` waits for a Signed Payment |

The key is the Agent's function-call key on the Allowance account (`request_spend` only, with a NEAR gas allowance). Never use the Owner's key here.

## Running

```sh
pnpm install
ALLOWANCE_ACCOUNT_ID=my-allowance.testnet \
ALLOWANCE_AGENT_KEY_FILE=~/.near-credentials/testnet/my-allowance-agent.json \
pnpm --filter allowance-mcp start
```

It speaks MCP over stdio and logs to stderr.

### Claude Code

```sh
claude mcp add allowance \
  -e ALLOWANCE_ACCOUNT_ID=my-allowance.testnet \
  -e ALLOWANCE_AGENT_KEY_FILE=/Users/me/.near-credentials/testnet/my-allowance-agent.json \
  -- pnpm --silent --dir /path/to/allowance/packages/mcp start
```

### Claude Desktop (`claude_desktop_config.json`) or any MCP client

```json
{
  "mcpServers": {
    "allowance": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/allowance/packages/mcp", "start"],
      "env": {
        "ALLOWANCE_ACCOUNT_ID": "my-allowance.testnet",
        "ALLOWANCE_AGENT_KEY_FILE": "/Users/me/.near-credentials/testnet/my-allowance-agent.json",
        "ALLOWANCE_NETWORK": "near:testnet"
      }
    }
  }
}
```

`--silent` keeps pnpm's banner off stdout, which carries the protocol. Alternatively, run `node --import tsx src/main.ts` from this directory.

## Code

- `src/client.ts`: `AllowanceClient`, the x402 + Allowance client shared with the sandbox tests (`packages/sandbox/src/agent.ts` binds it to the harness). It uses the official `@x402/fetch` wrapper, `x402Client` with spend controls disabled (the client's default $1 cap must not second-guess the Policy), and the `@x402/near` `exact` client scheme. The scheme's signer submits the Spend Request and returns the contract's `signed_delegate_action`.
- `src/contract.ts`: the contract calls (`request_spend` through the Agent's key) and views, over a near-api-js `Account` and its provider. A `busy:` panic becomes a `BusyError`.
- `src/offers.ts`: offer selection and dollar conversion.
- `src/results.ts`: result shaping.
- `src/server.ts`: the MCP tools.

`@x402/mcp` 2.30.0 was evaluated and isn't used. It adds x402 payments to MCP tool calls themselves (paid MCP tools, and an MCP client that pays them with a local signer). This server's job is different: paying x402 HTTP sellers through the Allowance, with no local payment key.

## Tests

```sh
pnpm --filter allowance-mcp test   # unit: offer selection, refusals, result shapes, resume, config
pnpm --filter sandbox exec vitest run test/mcp.test.ts   # end to end in the NEAR sandbox
```

The sandbox test drives the tools through an MCP client in process, against the demo seller under the demo Policy (Daily Cap $20, Auto Limit $5, Hard Ceiling $50, 10/hour):

- a $0.50 call is paid;
- paying an attacker who isn't on the Allowlist is Blocked (UnknownPayee);
- a $15 report goes Pending;
- a 5 × $4 split gets one payment through, and the other four are Blocked (DailyCapExceeded, counting the Pending $15);
- after the Owner approves, `allowance_resume` returns 200.
