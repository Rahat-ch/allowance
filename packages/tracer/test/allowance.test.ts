import { describe, expect, it } from "vitest";
import { tracerSignStatus, type TxStatusView } from "../src/allowance.js";

const RECEIPT = "Receipt1111";

function tx(receipts?: { id: string; status: unknown }[]): TxStatusView {
  return {
    transaction_outcome: { id: "TX", outcome: { receipt_ids: [RECEIPT] } },
    ...(receipts ? { receipts_outcome: receipts.map(r => ({ id: r.id, outcome: { status: r.status } })) } : {}),
  };
}

describe("tracerSignStatus", () => {
  it("is pending while the tracer_sign receipt has no outcome yet", () => {
    expect(tracerSignStatus(tx())).toEqual({ kind: "pending" });
    expect(tracerSignStatus(tx([{ id: "other", status: { SuccessValue: "" } }]))).toEqual({ kind: "pending" });
    expect(tracerSignStatus(tx([{ id: RECEIPT, status: "Unknown" }]))).toEqual({ kind: "pending" });
  });

  it("is pending when the RPC returned no outcome at all", () => {
    expect(tracerSignStatus({})).toEqual({ kind: "pending" });
  });

  it("is accepted once the tracer_sign receipt succeeded", () => {
    expect(tracerSignStatus(tx([{ id: RECEIPT, status: { SuccessReceiptId: "next" } }]))).toEqual({
      kind: "accepted",
    });
    expect(tracerSignStatus(tx([{ id: RECEIPT, status: { SuccessValue: "" } }]))).toEqual({ kind: "accepted" });
  });

  it("surfaces the contract's panic message when tracer_sign failed", () => {
    const failure = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: request id already used" } },
        },
      },
    };
    expect(tracerSignStatus(tx([{ id: RECEIPT, status: failure }]))).toEqual({
      kind: "failed",
      message: "Smart contract panicked: request id already used",
    });
  });

  it("describes a failure that is not a panic", () => {
    const failure = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x" } } } } };
    const status = tracerSignStatus(tx([{ id: RECEIPT, status: failure }]));
    expect(status.kind).toBe("failed");
    expect(status.kind === "failed" && status.message).toContain("AccountDoesNotExist");
  });
});
