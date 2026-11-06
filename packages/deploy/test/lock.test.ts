import { describe, expect, it } from "vitest";
import { verifyLock, type AccessKeyInfo, type LockEvidence } from "../src/lock.js";

const ALLOWANCE = "a1.owner.testnet";
const PAYER = `pay.${ALLOWANCE}`;
const AGENT = "ed25519:Agent111111111111111111111111111111111111111";
const DEPLOYER = "ed25519:Deployer1111111111111111111111111111111111111";
const DERIVED = ["ed25519:Derived0", "ed25519:Derived1", "ed25519:Derived2"];

const fullAccess = (public_key: string): AccessKeyInfo => ({ public_key, access_key: { permission: "FullAccess" } });
const functionCall = (public_key: string, receiver_id: string, method_names: string[]): AccessKeyInfo => ({
  public_key,
  access_key: { permission: { FunctionCall: { allowance: "1000000000000000000000000", receiver_id, method_names } } },
});

/** What a correctly locked Allowance looks like on chain. */
function locked(): LockEvidence {
  return {
    allowanceId: ALLOWANCE,
    allowanceKeys: [functionCall(AGENT, ALLOWANCE, ["request_spend"])],
    agentKey: AGENT,
    payerAccountId: PAYER,
    payerKeys: DERIVED.map(fullAccess),
    payerKeysView: [...DERIVED],
    derivedKeys: [...DERIVED],
    expectedKeyCount: 3,
    codeHash: { deployed: "Hash1", built: "Hash1" },
  };
}

describe("verifyLock", () => {
  it("passes a locked Allowance and says what it checked", () => {
    const report = verifyLock(locked());
    expect(report.problems).toEqual([]);
    expect(report.locked).toBe(true);
    expect(report.checks.join("\n")).toMatch(/no full-access key/);
    expect(report.checks.join("\n")).toMatch(/only request_spend/);
    expect(report.checks.join("\n")).toMatch(/exactly the 3 keys/);
    expect(report.checks.join("\n")).toMatch(/derived key/);
  });

  it("fails while the deployer's full-access key is still on the Allowance", () => {
    const e = locked();
    e.allowanceKeys.push(fullAccess(DEPLOYER));
    const report = verifyLock(e);
    expect(report.locked).toBe(false);
    expect(report.problems).toEqual([expect.stringMatching(/full-access keys: .*Deployer/)]);
  });

  it("fails when the Agent's key is full access", () => {
    const e = locked();
    e.allowanceKeys = [fullAccess(AGENT)];
    const report = verifyLock(e);
    expect(report.locked).toBe(false);
    expect(report.problems.join("\n")).toMatch(/full-access keys/);
    expect(report.problems.join("\n")).toMatch(/Agent's key must be a function-call key/);
  });

  it.each([
    ["any method (empty list)", []],
    ["an extra method", ["request_spend", "withdraw"]],
    ["the wrong method", ["approve"]],
  ])("fails when the Agent's key may call %s", (_, methods) => {
    const e = locked();
    e.allowanceKeys = [functionCall(AGENT, ALLOWANCE, methods)];
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/limited to \["request_spend"\]/)]);
  });

  it("fails when the Agent's key calls another contract", () => {
    const e = locked();
    e.allowanceKeys = [functionCall(AGENT, "usdc.testnet", ["request_spend"])];
    expect(verifyLock(e).locked).toBe(false);
  });

  it("fails when another function-call key sits next to the Agent's", () => {
    const e = locked();
    e.allowanceKeys.push(functionCall("ed25519:Other", ALLOWANCE, ["request_spend"]));
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/not the Agent's: ed25519:Other/)]);
  });

  it("fails when the Agent's key is missing", () => {
    const e = locked();
    e.allowanceKeys = [];
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/Agent's key .* is not on/)]);
  });

  it("fails when the Payer Account has a key the Allowance did not derive", () => {
    const e = locked();
    e.payerKeys.push(fullAccess(DEPLOYER));
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/did not derive: .*Deployer/)]);
  });

  it("fails when a recorded key is missing from the Payer Account", () => {
    const e = locked();
    e.payerKeys = e.payerKeys.slice(1);
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/lists ed25519:Derived0, which is not on/)]);
  });

  it("fails when payer_keys does not match the signer's derived keys", () => {
    const e = locked();
    e.derivedKeys = [DERIVED[0]!, DERIVED[2]!, DERIVED[1]!];
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/does not match the signer's derived_public_key/)]);
  });

  it("fails when there is no Payer Account", () => {
    const e = locked();
    e.payerKeys = [];
    e.payerKeysView = [];
    e.derivedKeys = [];
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/payer_keys\(\) is empty/)]);
  });

  it("fails when the Payer Account has fewer keys than asked for", () => {
    const e = locked();
    e.expectedKeyCount = 4;
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/lists 3 keys, expected 4/)]);
  });

  it("fails when a Payer Account key is not full access", () => {
    const e = locked();
    e.payerKeys[0] = functionCall(DERIVED[0]!, "usdc.testnet", []);
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/not full-access/)]);
  });

  it("fails when the deployed code is not the build", () => {
    const e = locked();
    e.codeHash = { deployed: "Other", built: "Hash1" };
    expect(verifyLock(e).problems).toEqual([expect.stringMatching(/runs code Other/)]);
  });
});
