import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, NETWORKS, isValidAccountId, parseConfig, type RawConfig } from "../src/config.js";
import { NEAR } from "../src/units.js";

function valid(): RawConfig {
  return {
    network: "testnet",
    owner: "owner.testnet",
    name: "allowance1",
    policy: { dailyCap: "5", autoLimit: "0.5", hardCeiling: "2", velocityLimit: 4, maxTimeoutBlocks: 120 },
    payees: ["seller.testnet"],
    keyCount: 4,
    fund: { usdc: "2", near: "5" },
  };
}

function problems(raw: RawConfig, overrides = {}): string[] {
  try {
    parseConfig(raw, overrides);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseConfig", () => {
  it("resolves a valid testnet config", () => {
    const { settings, warnings } = parseConfig(valid());
    expect(warnings).toEqual([]);
    expect(settings.network).toEqual(NETWORKS.testnet);
    expect(settings.network.signerId).toBe("v1.signer-prod.testnet");
    expect(settings.network.domainId).toBe(1);
    expect(settings.network.usdcContractId).toBe("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af");
    expect(settings.network.rpcUrls[0]).toBe("https://test.rpc.fastnear.com");
    expect(settings.allowanceId).toBe("allowance1.owner.testnet");
    expect(settings.payerAccountId).toBe("pay.allowance1.owner.testnet");
    expect(settings.policy).toEqual({
      daily_cap: "5000000",
      auto_limit: "500000",
      hard_ceiling: "2000000",
      velocity_limit: 4,
      max_timeout_blocks: 120,
    });
    expect(settings.fundUsdc).toBe(2_000_000n);
    expect(settings.fundNear).toBe(5n * NEAR);
    expect(settings.agentAllowance).toBe(NEAR);
    expect(settings.pool.verdict).toBe("ok");
  });

  it("the example config is valid", () => {
    const example = JSON.parse(readFileSync(new URL("../allowance.config.example.json", import.meta.url), "utf8")) as RawConfig;
    expect(() => parseConfig(example)).not.toThrow();
  });

  it("lets overrides win over the file", () => {
    const { settings } = parseConfig(valid(), { owner: "other.testnet", name: "fresh2" });
    expect(settings.allowanceId).toBe("fresh2.other.testnet");
  });

  it("needs rpcUrls, signerId and usdcContractId for the sandbox", () => {
    expect(problems({ ...valid(), network: "sandbox" })).toEqual([expect.stringMatching(/sandbox needs/)]);
    const { settings } = parseConfig({
      ...valid(),
      network: "sandbox",
      rpcUrls: ["http://127.0.0.1:3030"],
      signerId: "signer.test.near",
      usdcContractId: "usdc.test.near",
    });
    expect(settings.network).toMatchObject({ name: "sandbox", domainId: 1, signerId: "signer.test.near" });
    expect(settings.network.explorerUrl).toBeUndefined();
  });

  it("rejects an unknown network", () => {
    expect(problems({ ...valid(), network: "devnet" })).toEqual([expect.stringMatching(/network must be/)]);
  });

  it("collects every problem at once", () => {
    const found = problems({
      owner: "Not Valid",
      name: "has.dot",
      policy: { dailyCap: "1", autoLimit: "2", hardCeiling: "0", velocityLimit: 0, maxTimeoutBlocks: 601 },
      payees: ["ok.testnet", "ok.testnet", "BAD"],
      keyCount: 0,
      fund: { usdc: "1.0000001", near: "0.5" },
      agentGasNear: "0",
    });
    const all = found.join("\n");
    for (const pattern of [
      /owner "Not Valid"/,
      /name "has.dot"/,
      /hardCeiling must be positive/,
      /autoLimit must not exceed policy.hardCeiling/,
      /autoLimit must not exceed policy.dailyCap/,
      /velocityLimit must be an integer/,
      /maxTimeoutBlocks must be an integer in 1..600/,
      /payee "BAD"/,
      /duplicates/,
      /keyCount must be an integer in 1..32/,
      /fund.usdc/,
      /fund.near must be at least 1 NEAR/,
      /agentGasNear must be positive/,
    ]) {
      expect(all).toMatch(pattern);
    }
  });

  it("requires amounts as decimal strings, not numbers", () => {
    const raw = valid();
    (raw.policy as Record<string, unknown>).dailyCap = 5;
    expect(problems(raw)).toEqual([expect.stringMatching(/dailyCap must be a decimal string/)]);
  });

  it("refuses a Payer Account id over 64 characters", () => {
    expect(problems({ ...valid(), name: "a".repeat(50) })).toEqual([expect.stringMatching(/longer than 64/)]);
  });

  it("refuses a Payee that is the Allowance itself", () => {
    expect(problems({ ...valid(), payees: ["allowance1.owner.testnet"] })).toEqual([
      expect.stringMatching(/is the Allowance or its Payer Account/),
    ]);
  });

  it("refuses a key pool smaller than Velocity Limit x longest lease", () => {
    const raw = valid();
    raw.policy!.velocityLimit = 120;
    raw.policy!.maxTimeoutBlocks = 600;
    expect(problems(raw)).toEqual([expect.stringMatching(/keyCount 4 is too small/)]);
  });

  it("warns about a pool a burst could exhaust, an empty Allowlist and no USDC", () => {
    const raw = valid();
    raw.policy!.velocityLimit = 10;
    raw.payees = [];
    raw.fund!.usdc = "0";
    const { warnings } = parseConfig(raw);
    expect(warnings.join("\n")).toMatch(/burst/);
    expect(warnings.join("\n")).toMatch(/empty Allowlist/);
    expect(warnings.join("\n")).toMatch(/no USDC/);
  });
});

describe("isValidAccountId", () => {
  it.each(["owner.testnet", "a1", "x-y_z.near", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"])("accepts %s", (id) => {
    expect(isValidAccountId(id)).toBe(true);
  });
  it.each(["", "a", "Upper.testnet", "a..b", "-a.testnet", "a-.testnet", ".a", "a".repeat(65)])("rejects %j", (id) => {
    expect(isValidAccountId(id)).toBe(false);
  });
});
