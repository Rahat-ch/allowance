/**
 * Turning payment outcomes into what the Agent reads: plain JSON with a `result` tag,
 * USDC amounts in base units and dollars, times in ISO 8601, and a `next` hint saying
 * what to do. `error: true` results go back as MCP tool errors (isError).
 */
import type { PaymentRequirements } from "@x402/core/types";
import type { PayOutcome } from "./client.js";
import type { Budget, Policy, SpendRequest } from "./contract.js";
import { formatUsd } from "./offers.js";

/** Response bodies longer than this are cut (in characters) so they fit an Agent's context. */
export const MAX_BODY_CHARS = 8_000;

export type ToolResult = { error: boolean; data: Record<string, unknown> };

const UNCERTAIN =
  "Its fate is uncertain: do NOT start over with a new Request ID. Check it with allowance_get_request, then continue it with allowance_resume (same request_id).";

export async function shapePayOutcome(outcome: PayOutcome): Promise<ToolResult> {
  switch (outcome.kind) {
    case "free":
      return { error: false, data: { result: "no_payment_required", ...(await shapeResponse(outcome.response)) } };
    case "paid": {
      const http = await shapeResponse(outcome.response);
      const ok = outcome.response.ok;
      return {
        error: !ok,
        data: {
          result: ok ? "paid" : "payment_not_accepted",
          request_id: outcome.request.request_id,
          ...money(outcome.request.amount),
          payee: outcome.request.payee,
          ...http,
          settlement: outcome.settlement,
          ...(ok
            ? {}
            : {
                seller_error: outcome.sellerError,
                next:
                  "The seller did not accept the Signed Payment. It still counts as spent until it expires. Do not mint a new Request ID; allowance_resume with this request_id re-sends the same Signed Payment while it is valid.",
              }),
        },
      };
    }
    case "not_paid":
      return shapeUnpaid(outcome.request);
    case "busy":
      return {
        error: true,
        data: {
          result: "busy",
          retryable: true,
          request_id: outcome.requestId,
          ...offerMoney(outcome.offer),
          message: "Every signing key of the Allowance is in use. Nothing was stored or reserved.",
          next: "Retry shortly with allowance_pay and the SAME request_id.",
        },
      };
    case "still_signing":
      return {
        error: true,
        data: {
          result: "in_progress",
          retryable: true,
          request_id: outcome.requestId,
          status: outcome.request?.status ?? null,
          ...offerMoney(outcome.offer),
          message: "The Spend Request was accepted but its Signed Payment had not arrived yet.",
          next: `Wait, then call allowance_resume with this request_id. ${UNCERTAIN}`,
        },
      };
    case "refused":
      return {
        error: true,
        data: {
          result: "refused",
          reason: outcome.refusal.reason,
          message: `${outcome.refusal.message}. No Spend Request was made.`,
          offers: outcome.refusal.offers,
        },
      };
    case "unknown_request":
      return {
        error: true,
        data: {
          result: "unknown_request",
          request_id: outcome.requestId,
          message: "The Allowance has no such Spend Request (never submitted, or Blocked and not stored). Nothing was paid.",
        },
      };
    case "error":
      return {
        error: true,
        data: { result: "error", request_id: outcome.requestId, message: outcome.message, next: UNCERTAIN },
      };
  }
}

/** A Spend Request that produced no Signed Payment (now, or ever). */
export function shapeUnpaid(r: SpendRequest): ToolResult {
  const base = { request_id: r.request_id, ...money(r.amount), payee: r.payee, status: r.status };
  if (r.outcome === "Blocked") {
    return {
      error: true,
      data: {
        result: "blocked",
        reason: r.blocked_reason,
        ...base,
        ...limitDetail(r),
        stored: r.stored,
        message: blockedMessage(r),
      },
    };
  }
  if (r.blocked_reason) {
    // An approved spend whose Pickup was refused; the approval stays until its deadline.
    return {
      error: true,
      data: {
        result: "pickup_refused",
        reason: r.blocked_reason,
        ...base,
        pickup_deadline: iso(r.pickup_deadline_ns),
        retryable: r.blocked_reason === "Paused",
        next:
          r.blocked_reason === "Paused"
            ? "The Allowance is Paused. Retry allowance_resume with the same request_id after the Owner unpauses (before the pickup deadline)."
            : "This approved spend can't be picked up.",
      },
    };
  }
  if (r.status === "Pending") {
    return {
      error: false,
      data: {
        result: "pending",
        ...base,
        expires_at: iso(r.expires_at_ns),
        message: "Above the Auto Limit: waiting for the Owner to approve. It holds a Reservation against the Daily Cap.",
        next: "After the Owner approves, call allowance_resume with this request_id (and the same url/method/body) within 1 hour of approval. Do not submit a new request for the same purchase.",
      },
    };
  }
  if (r.status === "Approved") {
    return {
      error: false,
      data: {
        result: "approved",
        ...base,
        pickup_deadline: iso(r.pickup_deadline_ns),
        next: "Approved by the Owner: call allowance_resume with this request_id to pay.",
      },
    };
  }
  const why: Partial<Record<SpendRequest["status"], string>> = {
    Rejected: "The Owner rejected it.",
    Expired: "Nobody approved it within 24 hours.",
    Lapsed: "It was approved but not picked up within 1 hour.",
    Cancelled: "The Owner revoked the Agent or removed the Payee before it was signed.",
    FundingFailed: "The Allowance couldn't fund the payment (not enough unheld USDC). Nothing was spent.",
    SignatureUnavailable: "The signer didn't deliver a signature. It still counts as spent; nothing reached the seller.",
  };
  return {
    error: true,
    data: { result: "not_paid", ...base, message: why[r.status] ?? `The request is ${r.status}.` },
  };
}

function blockedMessage(r: SpendRequest): string {
  switch (r.blocked_reason) {
    case "UnknownPayee":
      return `${r.payee} is not on the Allowlist. Only the Owner can add Payees. This will never be paid.`;
    case "OverHardCeiling":
      return "Above the Hard Ceiling: no single spend this large is allowed, even with approval.";
    case "DailyCapExceeded":
      return "Over the Daily Cap (rolling 24 hours, Reservations included). Retry after retry_after.";
    case "VelocityExceeded":
      return "Over the Velocity Limit (Approved + Pending spends per rolling hour). Retry after retry_after.";
    case "Paused":
      return "The Owner has Paused the Allowance.";
    case "Revoked":
      return "The Agent has been revoked. Nothing will be paid again.";
    case "IdempotencyConflict":
      return "This Request ID was already used with a different Payee, amount or memo. Nothing was stored.";
    case "InvalidRequest":
      return "The request was malformed (memo, timeout or amount).";
    default:
      return "Blocked by the Policy.";
  }
}

function limitDetail(r: SpendRequest): Record<string, unknown> {
  if (!r.limit) return {};
  return {
    used: r.limit.used,
    used_usd: formatUsd(r.limit.used),
    limit: r.limit.limit,
    limit_usd: formatUsd(r.limit.limit),
    retry_after: iso(r.limit.retry_after_ns),
  };
}

/** A request as allowance_get_request shows it: no Signed Payment bytes, times in ISO. */
export function shapeRequest(r: SpendRequest): Record<string, unknown> {
  return {
    request_id: r.request_id,
    outcome: r.outcome,
    status: r.status,
    blocked_reason: r.blocked_reason,
    ...money(r.amount),
    payee: r.payee,
    memo: r.memo,
    requested_at: iso(r.requested_at_ns),
    expires_at: iso(r.expires_at_ns),
    pickup_deadline: iso(r.pickup_deadline_ns),
    ...limitDetail(r),
    stored: r.stored,
    signed_payment: r.payment
      ? { issued: r.payment.signed_delegate_action !== null, max_block_height: r.payment.max_block_height }
      : null,
  };
}

export function shapeBudget(b: Budget, policy: Policy, allowlist: string[], asset: string): Record<string, unknown> {
  return {
    asset,
    daily_cap: usd(b.daily_cap),
    used_in_window: usd(b.used_in_window),
    available: usd(b.available),
    next_release: iso(b.next_release_ns),
    velocity: { used: b.velocity_used, limit: b.velocity_limit },
    auto_limit: usd(policy.auto_limit),
    hard_ceiling: usd(policy.hard_ceiling),
    max_timeout_blocks: policy.max_timeout_blocks,
    usdc_balance: usd(b.usdc_balance),
    held: usd(b.held),
    allowlist,
  };
}

function usd(amount: string): { amount: string; usd: string } {
  return { amount, usd: formatUsd(amount) };
}

function money(amount: string): { amount: string; amount_usd: string } {
  return { amount, amount_usd: formatUsd(amount) };
}

function offerMoney(offer: PaymentRequirements): Record<string, unknown> {
  return { ...money(offer.amount), payee: offer.payTo };
}

/** Contract nanosecond timestamps as ISO 8601 (millisecond precision). */
export function iso(ns: number | null | undefined): string | null {
  if (ns === null || ns === undefined) return null;
  return new Date(Math.floor(ns / 1e6)).toISOString();
}

async function shapeResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const truncated = text.length > MAX_BODY_CHARS;
  return {
    http_status: response.status,
    content_type: response.headers.get("content-type"),
    body: truncated ? text.slice(0, MAX_BODY_CHARS) : text,
    body_truncated: truncated,
    ...(truncated ? { body_length: text.length } : {}),
  };
}
