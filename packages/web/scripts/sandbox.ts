/**
 * A local Allowance to click through the Owner page against: starts the sandbox harness,
 * submits a few Spend Requests as the Agent, and prints the page URL and an Owner key to
 * paste into the page's sandbox sign-in. Press Enter to submit another Pending spend;
 * Ctrl+C stops the sandbox.
 *
 *   pnpm --filter web sandbox      (then, in another terminal, pnpm --filter web dev)
 */
import { createInterface } from "node:readline";
import { KeyPair } from "@near-js/crypto";
import { newRequestId, requestSpend } from "sandbox/agent";
import { buildContracts } from "sandbox/contracts";
import { USDC, startHarness } from "sandbox/harness";

const PAGE = process.env.PAGE_URL ?? "http://localhost:5173/";

console.log("Building contracts and starting the sandbox…");
buildContracts();
const h = await startHarness({ allowanceUsdc: 500n * USDC });

const spend = (dollars: bigint, memo: string) =>
  requestSpend(h, { request_id: newRequestId(), payee: h.payee.accountId, amount: dollars * USDC, memo, max_timeout_blocks: 60 });

await spend(5n, "auto-approved lookup");
await spend(150n, "GPU hour");
await spend(120n, "dataset licence");

// A key for the page: the harness keeps the Owner's own key to itself.
const ownerKey = KeyPair.fromRandom("ed25519");
await h.owner.addFullAccessKey(ownerKey.getPublicKey().toString());

const url = new URL(PAGE);
url.searchParams.set("network", "sandbox");
url.searchParams.set("rpc", h.rpcUrl);
url.searchParams.set("allowance", h.allowance.accountId);

console.log(`
Allowance  ${h.allowance.accountId}
Owner      ${h.owner.accountId}
Owner key  ${ownerKey.toString()}
Payee      ${h.payee.accountId}

Open       ${url}
           and sign in with the Owner account and key above.

Enter: submit another Pending spend as the Agent.   Ctrl+C: stop.
`);

let n = 0;
const input = createInterface({ input: process.stdin });
input.on("line", async () => {
  n += 1;
  try {
    const r = await spend(101n + BigInt(n), `extra request ${n}`);
    console.log(`${r.request_id}: ${r.outcome}${r.blocked_reason ? ` (${r.blocked_reason})` : ""}`);
  } catch (e) {
    console.error("request_spend failed:", e instanceof Error ? e.message : e);
  }
});

async function stop() {
  input.close();
  await h.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
