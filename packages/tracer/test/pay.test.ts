import { describe, expect, it } from "vitest";
import { parsePayArgs, preflightProblems } from "../src/pay.js";

describe("parsePayArgs", () => {
  it("defaults to a new payment on a fast RPC", () => {
    expect(parsePayArgs([])).toEqual({ allowSlowRpc: false, help: false });
  });

  it("ignores the -- that pnpm passes through", () => {
    expect(parsePayArgs(["--"])).toEqual({ allowSlowRpc: false, help: false });
  });

  it.each([
    [["--request-id", "tracer-0123456789abcdef"]],
    [["--request-id=tracer-0123456789abcdef"]],
    [["--", "--request-id", "tracer-0123456789abcdef"]],
  ])("reads --request-id from %j", argv => {
    expect(parsePayArgs(argv).requestId).toBe("tracer-0123456789abcdef");
  });

  it("reads --allow-slow-rpc and --help", () => {
    expect(parsePayArgs(["--allow-slow-rpc", "--help"])).toEqual({ allowSlowRpc: true, help: true });
  });

  it.each([
    [["--request-id"]],
    [["--request-id", "--allow-slow-rpc"]],
    [["--request-id", "short"]],
    [["--request-id", "has spaces in it, not allowed"]],
    [["--request-id=" + "a".repeat(129)]],
  ])("rejects a missing or malformed request id in %j", argv => {
    expect(() => parsePayArgs(argv)).toThrow(/request-id/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parsePayArgs(["--fast"])).toThrow(/--fast/);
    expect(() => parsePayArgs(["5"])).toThrow(/5/);
  });
});

describe("preflightProblems", () => {
  const ok = {
    rpcUrl: "https://test.rpc.fastnear.com",
    allowSlowRpc: false,
    payee: "merchant.testnet",
    payeeRegistered: true,
    allowanceId: "allowance.owner.testnet",
    allowanceBalance: 10_000n,
    amount: 10_000n,
  };

  it("passes when everything is in place", () => {
    expect(preflightProblems(ok)).toEqual([]);
  });

  it("refuses a slow RPC", () => {
    const problems = preflightProblems({ ...ok, rpcUrl: "https://rpc.testnet.near.org" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/rpc\.testnet\.near\.org/);
    expect(problems[0]).toMatch(/--allow-slow-rpc/);
  });

  it("allows a slow RPC when overridden", () => {
    expect(preflightProblems({ ...ok, rpcUrl: "https://rpc.testnet.near.org", allowSlowRpc: true })).toEqual([]);
  });

  it("refuses a Payee without USDC storage", () => {
    const problems = preflightProblems({ ...ok, payeeRegistered: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/merchant\.testnet/);
    expect(problems[0]).toMatch(/storage/);
  });

  it("refuses when the Allowance holds less than the amount", () => {
    const problems = preflightProblems({ ...ok, allowanceBalance: 9_999n });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/0\.009999/);
    expect(problems[0]).toMatch(/0\.010000/);
  });

  it("skips the balance check when resuming an existing Signed Payment", () => {
    expect(preflightProblems({ ...ok, allowanceBalance: undefined })).toEqual([]);
  });

  it("lists every problem at once", () => {
    expect(
      preflightProblems({ ...ok, rpcUrl: "https://rpc.testnet.near.org", payeeRegistered: false, allowanceBalance: 0n }),
    ).toHaveLength(3);
  });
});
