import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { configFromEnv, readAgentKeyFile } from "../src/config.js";

const KEY = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";

function keyFile(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "allowance-mcp-")), "agent.json");
  writeFileSync(file, contents);
  chmodSync(file, 0o600);
  return file;
}

test("reads the Agent key from a near-cli credential file or a bare key file", () => {
  expect(readAgentKeyFile(keyFile(JSON.stringify({ account_id: "a.testnet", private_key: KEY })))).toBe(KEY);
  expect(readAgentKeyFile(keyFile(`${KEY}\n`))).toBe(KEY);
});

test("refuses a key file inside the repo and never echoes a bad file's contents", () => {
  const inRepo = fileURLToPath(new URL("../package.json", import.meta.url));
  expect(() => readAgentKeyFile(inRepo)).toThrow(/inside the repo/);
  const secretish = keyFile('{"private_key": "ed25519:SECRET');
  expect(() => readAgentKeyFile(secretish)).toThrow(/not a JSON credential file/);
  expect(() => readAgentKeyFile(secretish)).not.toThrow(/SECRET/);
});

test("config defaults to testnet over FastNEAR", () => {
  const config = configFromEnv({ ALLOWANCE_ACCOUNT_ID: "allowance.testnet", ALLOWANCE_AGENT_KEY: KEY });
  expect(config).toEqual({
    allowanceId: "allowance.testnet",
    network: "near:testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    agentKey: KEY,
    signTimeoutMs: 90_000,
  });
  expect(configFromEnv({ ALLOWANCE_ACCOUNT_ID: "a.near", ALLOWANCE_AGENT_KEY: KEY, ALLOWANCE_NETWORK: "mainnet" }).network).toBe("near:mainnet");
});

test("config requires the Allowance and exactly one key source", () => {
  expect(() => configFromEnv({ ALLOWANCE_AGENT_KEY: KEY })).toThrow(/ALLOWANCE_ACCOUNT_ID/);
  expect(() => configFromEnv({ ALLOWANCE_ACCOUNT_ID: "a.testnet" })).toThrow(/ALLOWANCE_AGENT_KEY_FILE/);
  expect(() => configFromEnv({ ALLOWANCE_ACCOUNT_ID: "a.testnet", ALLOWANCE_AGENT_KEY: "nope" })).toThrow(/not an ed25519/);
  expect(() => configFromEnv({ ALLOWANCE_ACCOUNT_ID: "a.testnet", ALLOWANCE_AGENT_KEY: KEY, ALLOWANCE_NETWORK: "base" })).toThrow(/ALLOWANCE_NETWORK/);
});
