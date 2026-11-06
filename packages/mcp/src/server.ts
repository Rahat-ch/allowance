/**
 * The MCP server: the Agent's tools for paying x402 sellers through its Allowance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AllowanceClient } from "./client.js";
import { usdToBaseUnits } from "./offers.js";
import { shapeBudget, shapePayOutcome, shapeRequest, type ToolResult } from "./results.js";

const NEVER_NEW_ID =
  "NEVER use a new Request ID for a payment whose fate is uncertain (timeout, crash, unclear result): " +
  "a new ID is a new payment. Check the old one with allowance_get_request and continue it with allowance_resume.";

const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "16-128 characters of [A-Za-z0-9_-]")
  .describe("Your Request ID for this purchase (16-128 characters of A-Z a-z 0-9 _ -).");

const httpCall = {
  url: z.string().url().describe("The URL to call."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP method."),
  body: z.string().optional().describe("Request body (e.g. JSON text), for POST/PUT/PATCH."),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers."),
};

export const TOOL_DESCRIPTIONS = {
  allowance_pay:
    "Call an HTTP URL and, if it answers 402 Payment Required (x402), pay it in USDC from your Allowance, then return the seller's response. " +
    "Pays only an x402 'exact' offer on the Allowance's NEAR network in the Allowance's USDC, and never more than max_usd. " +
    "Results: 'paid' (with the response body and the PAYMENT-RESPONSE settlement), 'no_payment_required', " +
    "'pending' (needs the Owner's approval: keep the request_id and call allowance_resume after approval), " +
    "'blocked' (the Policy refused it; see reason, and retry_after for DailyCapExceeded/VelocityExceeded), " +
    "'refused' (no acceptable offer; nothing was requested), 'busy' (retry with the SAME request_id), " +
    "'in_progress' (call allowance_resume later). " +
    "Every result that involved the Allowance includes request_id; pass request_id yourself to make retries safe. " +
    NEVER_NEW_ID,
  allowance_resume:
    "Continue an existing Spend Request by its request_id and complete the HTTP call: picks up the Signed Payment of a spend the Owner approved " +
    "(within 1 hour of approval), or re-sends the same Signed Payment after an uncertain result. Never creates a new payment; the offer must still match " +
    "the request's Payee and amount. Use the same url, method and body as the original call. " +
    NEVER_NEW_ID,
  allowance_get_request:
    "Read a Spend Request by request_id: its Outcome (Approved/Pending/Blocked), status (Pending, Approved, Funding, Signing, Signed, Rejected, Expired, " +
    "Lapsed, Cancelled, FundingFailed, SignatureUnavailable, Blocked), amount, Payee, expiry and pickup deadline. Use it to recover from uncertainty. " +
    NEVER_NEW_ID,
  allowance_get_budget:
    "Read your Allowance's budget: Daily Cap and how much of it is used (rolling 24 hours, Reservations included), what's available and when capacity frees up, " +
    "Velocity, Auto Limit (larger spends need the Owner's approval), Hard Ceiling, USDC balance and the Allowlist of Payees you may pay.",
} as const;

export function createAllowanceServer(client: AllowanceClient): McpServer {
  const server = new McpServer(
    { name: "allowance", version: "0.1.0" },
    {
      instructions:
        "Pay x402 sellers from a USDC budget the Owner controls on NEAR. You hold no funds and no payment key: every payment is a Spend Request the Allowance " +
        "contract approves, holds for the Owner, or blocks. " +
        NEVER_NEW_ID,
    },
  );

  server.registerTool(
    "allowance_pay",
    {
      title: "Pay for an HTTP call through the Allowance",
      description: TOOL_DESCRIPTIONS.allowance_pay,
      inputSchema: {
        ...httpCall,
        max_usd: z
          .union([z.string(), z.number()])
          .describe('Most you will pay for this call, in US dollars (USDC), e.g. "0.50". At most 6 decimals.'),
        request_id: requestIdSchema.optional().describe(
          "Optional Request ID (16-128 of A-Z a-z 0-9 _ -). Generated if omitted. Re-using an existing one continues that request instead of paying again.",
        ),
        memo: z.string().max(64).optional().describe("Short note recorded on-chain with the Spend Request (at most 64 bytes)."),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      let maxAmount: bigint;
      try {
        maxAmount = usdToBaseUnits(args.max_usd);
      } catch (error) {
        return toolResult({ error: true, data: { result: "invalid_input", message: (error as Error).message } });
      }
      const outcome = await client.pay({
        url: args.url,
        method: args.method,
        maxAmount,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.request_id ? { requestId: args.request_id } : {}),
        memo: args.memo ?? defaultMemo(args.method, args.url),
      });
      return toolResult(await shapePayOutcome(outcome));
    },
  );

  server.registerTool(
    "allowance_resume",
    {
      title: "Resume a Spend Request (Pickup after approval)",
      description: TOOL_DESCRIPTIONS.allowance_resume,
      inputSchema: { request_id: requestIdSchema, ...httpCall },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const outcome = await client.pay({
        url: args.url,
        method: args.method,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
        requestId: args.request_id,
        resumeOnly: true,
        maxAmount: 0n, // replaced by the request's own amount
      });
      return toolResult(await shapePayOutcome(outcome));
    },
  );

  server.registerTool(
    "allowance_get_request",
    {
      title: "Read a Spend Request",
      description: TOOL_DESCRIPTIONS.allowance_get_request,
      inputSchema: { request_id: requestIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ request_id }) => {
      const r = await client.getRequest(request_id);
      if (!r) {
        return toolResult({
          error: true,
          data: {
            result: "unknown_request",
            request_id,
            message: "No such Spend Request: never submitted, refused as busy, or Blocked and not stored. Nothing was paid for it.",
          },
        });
      }
      return toolResult({ error: false, data: { result: "request", ...shapeRequest(r) } });
    },
  );

  server.registerTool(
    "allowance_get_budget",
    {
      title: "Read the Allowance's budget",
      description: TOOL_DESCRIPTIONS.allowance_get_budget,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const c = client.contract;
      const [budget, policy, allowlist, asset] = await Promise.all([c.getBudget(), c.getPolicy(), c.getAllowlist(), c.getAsset()]);
      return toolResult({ error: false, data: { result: "budget", ...shapeBudget(budget, policy, allowlist, asset) } });
    },
  );

  return server;
}

/** JSON for the model to read, the same object as structured content for programs. */
function toolResult({ error, data }: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(error ? { isError: true } : {}),
  };
}

/**
 * A memo derived only from the call, so retrying the same call with the same Request ID
 * re-submits identical details. At most 64 bytes.
 */
export function defaultMemo(method: string, url: string): string {
  let target = url;
  try {
    const u = new URL(url);
    target = `${u.host}${u.pathname}`;
  } catch {
    // keep the raw url
  }
  let memo = `${method} ${target}`;
  while (Buffer.byteLength(memo) > 64) memo = memo.slice(0, -1);
  return memo;
}

