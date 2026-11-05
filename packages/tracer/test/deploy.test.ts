import { describe, expect, it } from "vitest";
import {
  agentKeyProblem,
  deployDecision,
  isNotInitializedError,
  parseDeployArgs,
  payerAccountState,
} from "../src/deploy.js";

const EMPTY = "11111111111111111111111111111111";

describe("parseDeployArgs", () => {
  it("reads --force", () => {
    expect(parseDeployArgs([])).toEqual({ force: false });
    expect(parseDeployArgs(["--", "--force"])).toEqual({ force: true });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseDeployArgs(["--yes"])).toThrow(/--yes/);
  });
});

describe("deployDecision", () => {
  const base = { accountId: "allowance.o.testnet", deployed: "OldHash", built: "NewHash", hasState: true, force: false };

  it("skips identical code", () => {
    expect(deployDecision({ ...base, deployed: "NewHash" })).toEqual({ action: "skip" });
  });

  it("deploys onto an account with no code", () => {
    expect(deployDecision({ ...base, deployed: EMPTY })).toEqual({ action: "deploy" });
  });

  it("deploys different code when there is no contract state", () => {
    expect(deployDecision({ ...base, hasState: false })).toEqual({ action: "deploy" });
  });

  it("refuses different code over existing state and says why", () => {
    const decision = deployDecision(base);
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.reason).toMatch(/OldHash/);
    expect(decision.reason).toMatch(/NewHash/);
    expect(decision.reason).toMatch(/state/);
    expect(decision.reason).toMatch(/--force/);
  });

  it("deploys over existing state with --force", () => {
    expect(deployDecision({ ...base, force: true })).toEqual({ action: "deploy" });
  });
});

describe("isNotInitializedError", () => {
  it("recognises the near-sdk panic for an uninitialized contract", () => {
    const viaTx = Object.assign(new Error("Contract panicked: The contract is not initialized"), {
      panicMessage: "The contract is not initialized",
    });
    const viaQuery = new Error(
      'wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: "The contract is not initialized" }))',
    );
    expect(isNotInitializedError(viaTx)).toBe(true);
    expect(isNotInitializedError(viaQuery)).toBe(true);
  });

  it.each([
    new Error("fetch failed"),
    new Error("Contract panicked: Cannot deserialize the contract state."),
    Object.assign(new Error("no code"), { name: "ContractCodeDoesNotExistError" }),
    "The contract is not initialized, said a string",
    undefined,
  ])("does not treat %s as uninitialized", error => {
    expect(isNotInitializedError(error)).toBe(false);
  });
});

describe("agentKeyProblem", () => {
  const allowanceId = "allowance.o.testnet";
  const fc = (receiver_id: string, method_names: string[]) => ({
    FunctionCall: { receiver_id, method_names, allowance: "1000000000000000000000000" },
  });

  it("accepts a function-call key for tracer_sign on the Allowance", () => {
    expect(agentKeyProblem(fc(allowanceId, ["tracer_sign"]), allowanceId)).toBeNull();
  });

  it.each([
    ["full access", "FullAccess" as const, /full-access/],
    ["another receiver", fc("usdc.testnet", ["tracer_sign"]), /usdc\.testnet/],
    ["any method", fc(allowanceId, []), /tracer_sign/],
    ["extra methods", fc(allowanceId, ["tracer_sign", "new"]), /tracer_sign/],
    ["another method", fc(allowanceId, ["new"]), /tracer_sign/],
    ["a gas key", { GasKeyFullAccess: { balance: "0", num_nonces: 1 } }, /function-call/],
  ])("rejects %s", (_label, permission, message) => {
    expect(agentKeyProblem(permission, allowanceId)).toMatch(message);
  });
});

describe("payerAccountState", () => {
  it.each([
    [["ed25519:a"], true, "ready"],
    [[], false, "missing"],
    [[], true, "keys-not-recorded"],
    [["ed25519:a"], false, "keys-without-account"],
  ] as const)("keys %j, exists %s -> %s", (keys, exists, state) => {
    expect(payerAccountState({ keys: [...keys], exists })).toBe(state);
  });
});
