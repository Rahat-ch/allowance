/**
 * Ticket #13: the Agent's MCP tools, driven through an MCP client in process, against the
 * demo seller and the demo Policy (Daily Cap $20, Auto Limit $5, Hard Ceiling $50,
 * Velocity 10/hour). The demo script: a $0.50 call is paid; paying an attacker is
 * Blocked; a $15 report goes Pending; a 5 x $4 split gets one through and the rest hit
 * the Daily Cap (the Pending $15 counts); the Owner approves the $15 and the Agent
 * resumes it.
 *
 * Paid calls run one at a time: one in-process facilitator can't settle two payments at
 * once (its relayer's nonce), see key-pool.test.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAllowanceServer } from "allowance-mcp";
import { startSeller, type Seller } from "seller";
import { afterAll, beforeAll, expect, test } from "vitest";
import { agentClient } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;
let seller: Seller;
let attackerSeller: Seller;
let splitSeller: Seller;
let mcp: Client;

beforeAll(async () => {
  h = await startHarness({
    policy: {
      daily_cap: (20n * USDC).toString(),
      auto_limit: (5n * USDC).toString(),
      hard_ceiling: (50n * USDC).toString(),
      velocity_limit: 10,
      max_timeout_blocks: 120,
    },
    // One key per Signed Payment outstanding at once ($0.50, $4, $15), plus one spare.
    payerKeys: 4,
  });
  const attacker = await h.createAccount("attacker", 5n);
  await h.registerUsdc(attacker.accountId);
  seller = await startSeller({ facilitator: h.facilitator, payTo: h.payee.accountId, asset: h.usdc.accountId });
  // A seller (injected into the Agent's context) that pays an account the Owner never allowed.
  attackerSeller = await startSeller({
    facilitator: h.facilitator,
    payTo: attacker.accountId,
    asset: h.usdc.accountId,
    prices: { weather: "$20.00" },
  });
  // The same Payee selling a $4 item, for the split attack.
  splitSeller = await startSeller({
    facilitator: h.facilitator,
    payTo: h.payee.accountId,
    asset: h.usdc.accountId,
    prices: { weather: "$4.00" },
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createAllowanceServer(agentClient(h)).connect(serverSide);
  mcp = new Client({ name: "demo-agent", version: "1.0.0" });
  await mcp.connect(clientSide);
});

afterAll(async () => {
  await mcp?.close();
  await Promise.all([seller?.close(), attackerSeller?.close(), splitSeller?.close()]);
  await h?.stop();
});

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const result = await mcp.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: result.structuredContent };
}

let pendingId: string;

test("a $0.50 call is paid through the Allowance and returns the seller's response", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const { isError, data } = await call("allowance_pay", { url: `${seller.url}/weather?city=Oslo`, max_usd: "1" });

  expect(isError).toBe(false);
  expect(data).toMatchObject({
    result: "paid",
    http_status: 200,
    amount: "500000",
    amount_usd: "$0.50",
    payee: h.payee.accountId,
    settlement: { success: true, network: "near:testnet", payer: h.payerAccountId },
  });
  expect(JSON.parse(data.body)).toMatchObject({ city: "Oslo" });
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + USDC / 2n);
  expect((await call("allowance_get_request", { request_id: data.request_id })).data).toMatchObject({
    outcome: "Approved",
    status: "Signed",
    memo: expect.stringContaining("/weather"),
  });
});

test("paying an attacker who is not on the Allowlist is Blocked (UnknownPayee)", async () => {
  const { isError, data } = await call("allowance_pay", { url: `${attackerSeller.url}/weather`, max_usd: "20" });
  expect(isError).toBe(true);
  expect(data).toMatchObject({ result: "blocked", reason: "UnknownPayee", amount_usd: "$20.00", request_id: expect.any(String) });
});

test("a $15 report goes Pending with its Request ID and expiry", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const { isError, data } = await call("allowance_pay", { url: `${seller.url}/report`, max_usd: "15" });
  expect(isError).toBe(false);
  expect(data).toMatchObject({ result: "pending", status: "Pending", amount_usd: "$15.00", expires_at: expect.any(String) });
  pendingId = data.request_id;
  expect(Date.parse(data.expires_at)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before);

  const budget = (await call("allowance_get_budget", {})).data;
  expect(budget).toMatchObject({ used_in_window: { usd: "$15.50" }, available: { usd: "$4.50" }, allowlist: [h.payee.accountId] });
});

test("a 5 x $4 split gets one through; the rest hit the Daily Cap, the Pending $15 included", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await call("allowance_pay", { url: `${splitSeller.url}/weather`, max_usd: "4" })).data);

  expect(results.map((r) => r.result)).toEqual(["paid", "blocked", "blocked", "blocked", "blocked"]);
  for (const r of results.slice(1)) {
    expect(r).toMatchObject({ reason: "DailyCapExceeded", used_usd: "$19.50", limit_usd: "$20.00", retry_after: expect.any(String) });
  }
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + 4n * USDC);
});

test("after the Owner approves, allowance_resume picks up the $15 and the seller is paid", async () => {
  const before = await h.usdcBalance(h.payee.accountId);
  // Resuming before approval answers from the chain: still Pending.
  expect((await call("allowance_resume", { request_id: pendingId, url: `${seller.url}/report` })).data).toMatchObject({ result: "pending" });

  await h.ownerCall("approve", { request_id: pendingId });
  expect((await call("allowance_get_request", { request_id: pendingId })).data).toMatchObject({ status: "Approved" });

  const { isError, data } = await call("allowance_resume", { request_id: pendingId, url: `${seller.url}/report` });
  expect(isError).toBe(false);
  expect(data).toMatchObject({ result: "paid", request_id: pendingId, http_status: 200, amount_usd: "$15.00", settlement: { success: true } });
  expect(JSON.parse(data.body)).toMatchObject({ title: expect.stringContaining("Premium report") });
  expect(await h.usdcBalance(h.payee.accountId)).toBe(before + 15n * USDC);
  expect((await call("allowance_get_request", { request_id: pendingId })).data).toMatchObject({ outcome: "Pending", status: "Signed" });
});
