import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeOverrides, parseArgs, setEnvValue } from "../src/main.js";

describe("parseArgs", () => {
  it("reads flags after pnpm's --", () => {
    expect(parseArgs(["--", "--config", "c.json", "--name", "a2", "--dry-run"])).toEqual({
      config: "c.json",
      dryRun: true,
      help: false,
      overrides: { name: "a2" },
    });
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument --force/);
    expect(() => parseArgs(["--name"])).toThrow(/--name needs a value/);
    expect(() => parseArgs(["--name", "--dry-run"])).toThrow(/--name needs a value/);
  });
});

describe("mergeOverrides", () => {
  it("lets flags win over the environment and ignores blank variables", () => {
    expect(
      mergeOverrides({ OWNER_ACCOUNT_ID: "env.testnet", ALLOWANCE_NAME: "envname", NEAR_NETWORK: " " }, { name: "flag" }),
    ).toEqual({ owner: "env.testnet", name: "flag" });
  });
});

describe("setEnvValue", () => {
  it("replaces an existing line and appends a new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "A=1\nALLOWANCE_ACCOUNT_ID=old\nB=2");
      setEnvValue("ALLOWANCE_ACCOUNT_ID", "new.testnet", file);
      setEnvValue("AGENT_KEY_FILE", "/k.json", file);
      expect(readFileSync(file, "utf8")).toBe("A=1\nALLOWANCE_ACCOUNT_ID=new.testnet\nB=2\nAGENT_KEY_FILE=/k.json\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
