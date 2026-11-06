import { expect, test } from "vitest";
import { explainError, ownerCalls, parseBudget, parseSpendRequest } from "../src/allowance.js";
import { resolveConfig } from "../src/config.js";
import { assertSucceeded } from "../src/wallet.js";

test("approve and reject name the request and attach exactly 1 yoctoNEAR", () => {
  expect(ownerCalls.approve("req_abcdefghijklmnop")).toEqual({
    methodName: "approve",
    args: { request_id: "req_abcdefghijklmnop" },
    gas: 30_000_000_000_000n,
    deposit: 1n,
  });
  expect(ownerCalls.reject("req_abcdefghijklmnop")).toMatchObject({
    methodName: "reject",
    args: { request_id: "req_abcdefghijklmnop" },
    deposit: 1n,
  });
});

test("unpause and revoke need the 1 yoctoNEAR confirmation; pause does not", () => {
  expect(ownerCalls.unpause()).toMatchObject({ methodName: "unpause", args: {}, deposit: 1n });
  expect(ownerCalls.revoke()).toMatchObject({ methodName: "revoke", args: {}, deposit: 1n });
  expect(ownerCalls.revoke().gas).toBe(100_000_000_000_000n);
  // A sign-in function-call key can't attach a deposit, so Pause stays deposit-free.
  expect(ownerCalls.pause()).toMatchObject({ methodName: "pause", args: {}, deposit: 0n });
});

test("view JSON parses into bigint amounts", () => {
  const r = parseSpendRequest({
    request_id: "req_abcdefghijklmnop",
    payee: "payee.testnet",
    amount: "15000000",
    memo: "weather API",
    outcome: "Pending",
    status: "Pending",
    blocked_reason: null,
    requested_at_ns: 1_800_000_000_000_000_000,
    expires_at_ns: 1_800_086_400_000_000_000,
    pickup_deadline_ns: null,
  });
  expect(r).toMatchObject({ requestId: "req_abcdefghijklmnop", amount: 15_000_000n, memo: "weather API", pickupDeadlineNs: null });

  const b = parseBudget({
    used_in_window: "20000000",
    daily_cap: "100000000",
    available: "80000000",
    next_release_ns: null,
    velocity_used: 2,
    velocity_limit: 10,
    usdc_balance: "50000000",
    held: "15000000",
    withdrawable: "35000000",
    near_balance: "5000000000000000000000000",
  });
  expect(b).toMatchObject({ usedInWindow: 20_000_000n, available: 80_000_000n, withdrawable: 35_000_000n, nearBalance: 5n * 10n ** 24n });
});

test("contract panics read as plain explanations", () => {
  const panic = (msg: string) =>
    new Error(`Transaction failed: {"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${msg}"}}}}`);
  expect(explainError(panic("request already decided"))).toMatch(/already decided/);
  expect(explainError(panic("request expired"))).toMatch(/Expired/);
  expect(explainError(panic("request lapsed"))).toMatch(/Lapsed/);
  expect(explainError(panic("unknown request"))).toMatch(/No such Spend Request/);
  expect(explainError(panic("request no longer qualifies: OverHardCeiling"))).toMatch(/Hard Ceiling/);
  expect(explainError(panic("only the Owner"))).toMatch(/Only the Owner/);
  expect(explainError(panic("Requires attached deposit of exactly 1 yoctoNEAR"))).toMatch(/wallet confirmation/);
  // The message can sit in an error's cause.
  expect(explainError(new Error("call failed", { cause: panic("request expired") }))).toMatch(/Expired/);
  expect(explainError(new Error("something odd"))).toBe("something odd");
});

test("a failed outcome a wallet hands back becomes an error", () => {
  expect(() => assertSucceeded({ status: { SuccessValue: "" } })).not.toThrow();
  expect(() => assertSucceeded(undefined)).not.toThrow();
  const failed = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: request already decided" } } } } } };
  expect(() => assertSucceeded(failed)).toThrow(/request already decided/);
});

test("config: the URL wins, then what this browser remembered, then testnet defaults", () => {
  const q = (s: string) => new URLSearchParams(s);
  expect(resolveConfig(q(""), null)).toEqual({ network: "testnet", rpcUrl: "https://rpc.testnet.fastnear.com", allowanceId: "" });
  expect(resolveConfig(q("?allowance=a.testnet"), { network: "testnet", rpcUrl: "https://my.rpc", allowanceId: "b.testnet" })).toEqual({
    network: "testnet",
    rpcUrl: "https://my.rpc",
    allowanceId: "a.testnet",
  });
  expect(resolveConfig(q("?network=sandbox&rpc=http://127.0.0.1:4000&allowance=x.test.near"), null)).toEqual({
    network: "sandbox",
    rpcUrl: "http://127.0.0.1:4000",
    allowanceId: "x.test.near",
  });
  // Remembered settings for another network don't leak into this one.
  expect(resolveConfig(q("?network=mainnet"), { network: "testnet", rpcUrl: "https://my.rpc", allowanceId: "b.testnet" })).toEqual({
    network: "mainnet",
    rpcUrl: "https://rpc.mainnet.fastnear.com",
    allowanceId: "",
  });
});
