/**
 * The MCP tools against a stub Allowance and a stub x402 seller: offer refusals, result
 * shapes for every outcome, and that resume re-submits the same Request ID.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AllowanceClient } from "../src/client.js";
import { BusyError, type AllowanceContract, type SpendArgs, type SpendRequest } from "../src/contract.js";
import { MAX_BODY_CHARS } from "../src/results.js";
import { TOOL_DESCRIPTIONS, createAllowanceServer } from "../src/server.js";

const USDC = "usdc.testnet";
const SELLER = "seller.testnet";
const SIGNED = "c2lnbmVkLWRlbGVnYXRl";
const NOW_NS = 1_700_000_000_000_000_000;

// ---- a stub seller -------------------------------------------------------------------

type Seller = { accepts: PaymentRequirements[]; body: string; paidWith: string[]; reject?: boolean };
let seller: Seller;

const offer = (o: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "near:testnet",
  asset: USDC,
  amount: "500000",
  payTo: SELLER,
  maxTimeoutSeconds: 60,
  extra: {},
  ...o,
});

const sellerFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const signature = request.headers.get("payment-signature");
  if (seller.accepts.length === 0) return new Response(seller.body, { status: 200, headers: { "content-type": "text/plain" } });
  if (signature && !seller.reject) {
    seller.paidWith.push((decodePaymentSignatureHeader(signature).payload as { signedDelegateAction: string }).signedDelegateAction);
    const settlement = encodePaymentResponseHeader({ success: true, transaction: "tx123", network: "near:testnet", payer: "pay.allowance.testnet" });
    return new Response(seller.body, { status: 200, headers: { "content-type": "application/json", "payment-response": settlement } });
  }
  const required = encodePaymentRequiredHeader({
    x402Version: 2,
    ...(signature ? { error: "invalid_payment" } : {}),
    resource: { url: request.url, description: "stub", mimeType: "application/json" },
    accepts: seller.accepts,
  });
  return new Response("{}", { status: 402, headers: { "payment-required": required } });
};

// ---- a stub Allowance ----------------------------------------------------------------

type Decision = (args: SpendArgs) => Partial<SpendRequest> | "busy";
let decide: Decision;
let requests: Map<string, SpendRequest>;
let submitted: SpendArgs[];

function spendRequest(args: SpendArgs, fields: Partial<SpendRequest>): SpendRequest {
  return {
    request_id: args.request_id,
    payee: args.payee,
    amount: args.amount.toString(),
    memo: args.memo ?? null,
    max_timeout_blocks: args.max_timeout_blocks,
    requested_at_ns: NOW_NS,
    outcome: "Approved",
    status: "Funding",
    blocked_reason: null,
    limit: null,
    reserved_hour: null,
    stored: true,
    expires_at_ns: null,
    pickup_deadline_ns: null,
    payment: null,
    ...fields,
  };
}

const stubAllowance: AllowanceContract = {
  allowanceId: "allowance.testnet",
  async requestSpend(args) {
    submitted.push(args);
    const existing = requests.get(args.request_id);
    if (existing && existing.status !== "Approved") return existing;
    const d = decide(args);
    if (d === "busy") throw new BusyError("request_spend failed: busy: all signing keys are in use");
    const r = spendRequest(args, existing ? { ...existing, ...d } : d);
    if (r.stored) requests.set(r.request_id, r);
    return r;
  },
  async getRequest(id) {
    const r = requests.get(id);
    // Signing completes on the first poll.
    if (r && (r.status === "Funding" || r.status === "Signing")) {
      const signed = { ...r, status: "Signed" as const, payment: { key_index: 0, public_key: "ed25519:x", nonce: 1, max_block_height: 100, signed_delegate_action: SIGNED } };
      requests.set(id, signed);
      return r;
    }
    return r ?? null;
  },
  async getBudget() {
    return {
      used_in_window: "500000",
      daily_cap: "20000000",
      available: "19500000",
      next_release_ns: null,
      velocity_used: 1,
      velocity_limit: 10,
      usdc_balance: "99500000",
      held: "0",
      withdrawable: "99500000",
      near_balance: "1",
    };
  },
  async getPolicy() {
    return { daily_cap: "20000000", auto_limit: "5000000", hard_ceiling: "50000000", velocity_limit: 10, max_timeout_blocks: 120 };
  },
  async getAllowlist() {
    return [SELLER];
  },
  async getAsset() {
    return USDC;
  },
  async getKeyPool() {
    return { keys: 2, free: 2, next_free_height: null };
  },
};

// ---- the MCP client ------------------------------------------------------------------

let mcp: Client;

beforeEach(async () => {
  seller = { accepts: [offer()], body: JSON.stringify({ city: "Lisbon" }), paidWith: [] };
  requests = new Map();
  submitted = [];
  decide = () => ({ outcome: "Approved", status: "Funding" });
  const client = new AllowanceClient(stubAllowance, { network: "near:testnet", fetch: sellerFetch, pollIntervalMs: 1, signTimeoutMs: 1_000 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createAllowanceServer(client).connect(serverSide);
  mcp = new Client({ name: "test-agent", version: "1.0.0" });
  await mcp.connect(clientSide);
});

afterEach(async () => {
  await mcp.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const result = await mcp.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: result.structuredContent };
}

const pay = (args: Record<string, unknown> = {}) => call("allowance_pay", { url: "https://seller.example/weather", max_usd: "1", ...args });

// ---- tests ---------------------------------------------------------------------------

test("lists the four tools, each warning against minting a new Request ID", async () => {
  const { tools } = await mcp.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["allowance_get_budget", "allowance_get_request", "allowance_pay", "allowance_resume"]);
  for (const name of ["allowance_pay", "allowance_resume", "allowance_get_request"] as const) {
    expect(TOOL_DESCRIPTIONS[name]).toMatch(/NEVER use a new Request ID for a payment whose fate is uncertain/);
  }
  const payTool = tools.find((t) => t.name === "allowance_pay")!;
  expect(payTool.inputSchema.required?.sort()).toEqual(["max_usd", "url"]);
});

test("a paid call returns the body, the settlement, and pays exactly the offer through the Allowance", async () => {
  const { isError, data } = await pay({ request_id: "req_paid_0000000001" });
  expect(isError).toBe(false);
  expect(data).toMatchObject({
    result: "paid",
    request_id: "req_paid_0000000001",
    amount: "500000",
    amount_usd: "$0.50",
    payee: SELLER,
    http_status: 200,
    body: JSON.stringify({ city: "Lisbon" }),
    body_truncated: false,
    settlement: { success: true, transaction: "tx123", network: "near:testnet" },
  });
  expect(seller.paidWith).toEqual([SIGNED]);
  expect(submitted).toEqual([
    { request_id: "req_paid_0000000001", payee: SELLER, amount: 500_000n, memo: "GET seller.example/weather", max_timeout_blocks: 60 },
  ]);
});

test("a free call is returned without a Spend Request", async () => {
  seller.accepts = [];
  const { isError, data } = await pay();
  expect(isError).toBe(false);
  expect(data).toMatchObject({ result: "no_payment_required", http_status: 200 });
  expect(submitted).toHaveLength(0);
});

test("over max_usd is refused before any Spend Request", async () => {
  seller.accepts = [offer({ amount: "15000000" })];
  const { isError, data } = await pay({ max_usd: "5" });
  expect(isError).toBe(true);
  expect(data).toMatchObject({ result: "refused", reason: "OverMaxAmount" });
  expect(submitted).toHaveLength(0);
});

test("an offer in another asset or on another network is refused", async () => {
  seller.accepts = [offer({ asset: "fake-usdc.testnet" })];
  expect((await pay()).data).toMatchObject({ result: "refused", reason: "AssetMismatch" });
  seller.accepts = [offer({ network: "near:mainnet" }), offer({ network: "eip155:8453", asset: "0xabc" })];
  expect((await pay()).data).toMatchObject({ result: "refused", reason: "NoMatchingOffer", offers: expect.any(Array) });
  expect(submitted).toHaveLength(0);
});

test("Pending comes back with the request_id and expiry, as a normal result", async () => {
  decide = () => ({ outcome: "Pending", status: "Pending", expires_at_ns: NOW_NS + 86_400_000_000_000 });
  const { isError, data } = await pay({ request_id: "req_pending_000000001", max_usd: "20" });
  expect(isError).toBe(false);
  expect(data).toMatchObject({
    result: "pending",
    request_id: "req_pending_000000001",
    status: "Pending",
    expires_at: new Date(NOW_NS / 1e6 + 86_400_000).toISOString(),
  });
  expect(seller.paidWith).toEqual([]);
});

test("Blocked comes back as a tool error with the reason and limit detail", async () => {
  decide = () => ({
    outcome: "Blocked",
    status: "Blocked",
    blocked_reason: "DailyCapExceeded",
    limit: { used: "19000000", limit: "20000000", retry_after_ns: NOW_NS + 3_600_000_000_000 },
  });
  const { isError, data } = await pay();
  expect(isError).toBe(true);
  expect(data).toMatchObject({
    result: "blocked",
    reason: "DailyCapExceeded",
    used: "19000000",
    used_usd: "$19.00",
    limit_usd: "$20.00",
    retry_after: new Date(NOW_NS / 1e6 + 3_600_000).toISOString(),
    request_id: expect.any(String),
  });
});

test("busy is a retryable tool error that keeps the Request ID", async () => {
  decide = () => "busy";
  const { isError, data } = await pay({ request_id: "req_busy_00000000001" });
  expect(isError).toBe(true);
  expect(data).toMatchObject({ result: "busy", retryable: true, request_id: "req_busy_00000000001", next: expect.stringContaining("SAME request_id") });
});

test("a Spend Request still signing when the wait ends is in_progress, not a failure", async () => {
  const slow = new AllowanceClient(
    { ...stubAllowance, getRequest: async (id) => (requests.has(id) ? { ...requests.get(id)!, status: "Signing" } : null) },
    { network: "near:testnet", fetch: sellerFetch, pollIntervalMs: 1, signTimeoutMs: 20 },
  );
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createAllowanceServer(slow).connect(s);
  const other = new Client({ name: "t", version: "1" });
  await other.connect(c);
  const result = await other.callTool({ name: "allowance_pay", arguments: { url: "https://seller.example/x", max_usd: 1, request_id: "req_slow_00000000001" } });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ result: "in_progress", request_id: "req_slow_00000000001", next: expect.stringContaining("allowance_resume") });
  await other.close();
});

test("resume picks up an approved request with the same Request ID and memo, then pays", async () => {
  decide = () => ({ outcome: "Pending", status: "Pending" });
  await pay({ request_id: "req_resume_000000001", max_usd: "20", memo: "report" });
  // Before approval, resume answers from the chain without calling the seller.
  expect((await call("allowance_resume", { request_id: "req_resume_000000001", url: "https://seller.example/weather" })).data).toMatchObject({
    result: "pending",
  });
  expect(submitted).toHaveLength(1);

  requests.set("req_resume_000000001", { ...requests.get("req_resume_000000001")!, status: "Approved", pickup_deadline_ns: NOW_NS + 3_600_000_000_000 });
  decide = () => ({ status: "Funding" });
  const { isError, data } = await call("allowance_resume", { request_id: "req_resume_000000001", url: "https://seller.example/weather" });
  expect(isError).toBe(false);
  expect(data).toMatchObject({ result: "paid", request_id: "req_resume_000000001", http_status: 200 });
  expect(submitted[1]).toMatchObject({ request_id: "req_resume_000000001", memo: "report", amount: 500_000n });
});

test("resume refuses an offer that no longer matches the request", async () => {
  requests.set("req_mismatch_0000001", spendRequest(
    { request_id: "req_mismatch_0000001", payee: SELLER, amount: 500_000n, max_timeout_blocks: 60 },
    { outcome: "Pending", status: "Approved" },
  ));
  seller.accepts = [offer({ payTo: "attacker.testnet" })];
  const { data } = await call("allowance_resume", { request_id: "req_mismatch_0000001", url: "https://seller.example/weather" });
  expect(data).toMatchObject({ result: "refused", reason: "RequestMismatch" });
  expect(submitted).toHaveLength(0);
});

test("resume of an unknown Request ID never creates one", async () => {
  const { isError, data } = await call("allowance_resume", { request_id: "req_unknown_00000001", url: "https://seller.example/weather" });
  expect(isError).toBe(true);
  expect(data).toMatchObject({ result: "unknown_request" });
  expect(submitted).toHaveLength(0);
});

test("a payment the seller rejects is reported with the seller's error and the Request ID", async () => {
  seller.reject = true;
  const { isError, data } = await pay({ request_id: "req_rejected_0000001" });
  expect(isError).toBe(true);
  expect(data).toMatchObject({ result: "payment_not_accepted", http_status: 402, seller_error: "invalid_payment", request_id: "req_rejected_0000001" });
});

test("long bodies are truncated", async () => {
  seller.body = "x".repeat(MAX_BODY_CHARS + 10);
  const { data } = await pay();
  expect(data).toMatchObject({ body_truncated: true, body_length: MAX_BODY_CHARS + 10 });
  expect(data.body).toHaveLength(MAX_BODY_CHARS);
});

test("invalid max_usd and request_id are rejected", async () => {
  expect((await pay({ max_usd: "lots" })).data).toMatchObject({ result: "invalid_input" });
  const bad = await mcp.callTool({ name: "allowance_pay", arguments: { url: "https://seller.example/x", max_usd: "1", request_id: "short" } });
  expect(bad.isError).toBe(true);
  expect(submitted).toHaveLength(0);
});

test("get_request shows a request without the Signed Payment bytes; unknown ones say so", async () => {
  await pay({ request_id: "req_view_00000000001" });
  const { data } = await call("allowance_get_request", { request_id: "req_view_00000000001" });
  expect(data).toMatchObject({ result: "request", status: "Signed", outcome: "Approved", amount_usd: "$0.50", signed_payment: { issued: true } });
  expect(JSON.stringify(data)).not.toContain(SIGNED);
  expect((await call("allowance_get_request", { request_id: "req_nothing_00000001" })).data).toMatchObject({ result: "unknown_request" });
});

test("get_budget shows the cap, usage, limits and Allowlist in dollars", async () => {
  const { data } = await call("allowance_get_budget", {});
  expect(data).toMatchObject({
    result: "budget",
    asset: USDC,
    daily_cap: { usd: "$20.00" },
    available: { usd: "$19.50" },
    auto_limit: { usd: "$5.00" },
    hard_ceiling: { usd: "$50.00" },
    velocity: { used: 1, limit: 10 },
    allowlist: [SELLER],
  });
});
