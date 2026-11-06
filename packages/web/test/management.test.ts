import { expect, test } from "vitest";
import {
  addPayeeCalls,
  describeBlockedReason,
  explainError,
  isAccountId,
  isPublicKey,
  ownerCalls,
  policyProblems,
  removalEffects,
  usdcCalls,
  withdrawProblem,
  type Policy,
  type SpendRequest,
} from "../src/allowance.js";
import { parseNear, usdcInput } from "../src/format.js";

const USD = 1_000_000n;
const POLICY: Policy = { dailyCap: 100n * USD, autoLimit: 5n * USD, hardCeiling: 50n * USD, velocityLimit: 20, maxTimeoutBlocks: 120 };

test("set_policy sends the Policy in contract units with 1 yoctoNEAR", () => {
  expect(ownerCalls.setPolicy(POLICY)).toMatchObject({
    methodName: "set_policy",
    args: { policy: { daily_cap: "100000000", auto_limit: "5000000", hard_ceiling: "50000000", velocity_limit: 20, max_timeout_blocks: 120 } },
    deposit: 1n,
  });
});

test("Allowlist calls: add needs 1 yoctoNEAR, remove (tightening) needs none", () => {
  expect(ownerCalls.addPayee("api.near")).toMatchObject({ methodName: "add_payee", args: { payee: "api.near" }, deposit: 1n });
  expect(ownerCalls.removePayee("api.near")).toMatchObject({ methodName: "remove_payee", args: { payee: "api.near" }, deposit: 0n });
  expect(ownerCalls.addPayee("api.near").receiverId).toBeUndefined(); // the Allowance
});

test("adding an unregistered Payee registers its USDC storage first, on the token", () => {
  const deposit = 1_250_000_000_000_000_000_000n;
  expect(addPayeeCalls("usdc.near", "api.near", { registered: false, deposit })).toEqual([
    usdcCalls.storageDeposit("usdc.near", "api.near", deposit),
    ownerCalls.addPayee("api.near"),
  ]);
  expect(usdcCalls.storageDeposit("usdc.near", "api.near", deposit)).toMatchObject({
    receiverId: "usdc.near",
    methodName: "storage_deposit",
    args: { account_id: "api.near", registration_only: true },
    deposit,
  });
  expect(addPayeeCalls("usdc.near", "api.near", { registered: true, deposit })).toEqual([ownerCalls.addPayee("api.near")]);
});

test("withdraw and replace_agent_key carry their amounts as strings with 1 yoctoNEAR", () => {
  expect(ownerCalls.withdraw(25n * USD)).toMatchObject({ methodName: "withdraw", args: { amount: "25000000" }, deposit: 1n });
  const key = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
  expect(ownerCalls.replaceAgentKey(key, 10n ** 24n)).toMatchObject({
    methodName: "replace_agent_key",
    args: { public_key: key, allowance: "1000000000000000000000000" },
    deposit: 1n,
  });
  expect(ownerCalls.replaceAgentKey(key).args).toEqual({ public_key: key });
});

test("the page checks the contract's Policy rules before the wallet opens", () => {
  expect(policyProblems(POLICY)).toEqual([]);
  expect(policyProblems({ ...POLICY, autoLimit: 60n * USD })).toEqual(["Auto Limit must not exceed the Hard Ceiling."]);
  expect(policyProblems({ ...POLICY, hardCeiling: 500n * USD, autoLimit: 200n * USD })).toEqual(["Auto Limit must not exceed the Daily Cap."]);
  expect(policyProblems({ ...POLICY, dailyCap: 0n })).toContain("Daily Cap must be positive.");
  expect(policyProblems({ ...POLICY, velocityLimit: 1.5 })).toHaveLength(1);
  expect(policyProblems({ ...POLICY, maxTimeoutBlocks: 601 })).toHaveLength(1);
  expect(policyProblems({ ...POLICY, maxTimeoutBlocks: 0 })).toHaveLength(1);
});

test("withdraw is limited to Withdrawable", () => {
  expect(withdrawProblem(10n * USD, 10n * USD)).toBeNull();
  expect(withdrawProblem(10n * USD + 1n, 10n * USD)).toMatch(/more than is Withdrawable/);
  expect(withdrawProblem(0n, 10n * USD)).toMatch(/above/);
  expect(withdrawProblem(null, 10n * USD)).toMatch(/Enter an amount/);
});

test("removing a Payee rejects its Pending spends and cancels its approved ones", () => {
  const r = (id: string, payee: string, status: "Pending" | "Approved") => ({ requestId: id, payee, status, amount: USD }) as SpendRequest;
  const pending = [r("a", "x.near", "Pending"), r("b", "y.near", "Pending"), r("c", "x.near", "Approved")];
  const effects = removalEffects(pending, "x.near");
  expect(effects.rejected.map((s) => s.requestId)).toEqual(["a"]);
  expect(effects.cancelled.map((s) => s.requestId)).toEqual(["c"]);
  expect(removalEffects(pending, "z.near")).toEqual({ rejected: [], cancelled: [] });
});

test("account IDs, public keys and Blocked reasons", () => {
  expect(isAccountId("payee.testnet")).toBe(true);
  expect(isAccountId("a1b2".repeat(16))).toBe(true); // implicit (64 hex)
  expect(isAccountId("Payee.near")).toBe(false);
  expect(isAccountId("x")).toBe(false);
  expect(isAccountId("bad..near")).toBe(false);
  expect(isPublicKey("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp")).toBe(true);
  expect(isPublicKey("ed25519:0OIl")).toBe(false);
  expect(isPublicKey("secp256k1:abc")).toBe(false);
  expect(describeBlockedReason("DailyCapExceeded")).toBe("Daily Cap exceeded");
  expect(describeBlockedReason(null)).toBeNull();
  expect(explainError(new Error("Smart contract panicked: amount exceeds Withdrawable: 5 requested"))).toMatch(/more than is Withdrawable/);
});

test("NEAR typed by a person parses to yoctoNEAR; USDC prefills inputs as plain dollars", () => {
  expect(parseNear("1")).toBe(10n ** 24n);
  expect(parseNear("0.25")).toBe(25n * 10n ** 22n);
  expect(parseNear("-1")).toBeNull();
  expect(parseNear("one")).toBeNull();
  expect(usdcInput(12_500_000n)).toBe("12.5");
  expect(usdcInput(100_000_000n)).toBe("100");
  expect(usdcInput(1n)).toBe("0.000001");
});
