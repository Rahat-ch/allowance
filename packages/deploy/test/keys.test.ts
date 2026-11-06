import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, assertOutsideRepo, isInsideRepo, readKeyFile, writeKeyFile } from "../src/keys.js";

const SECRET = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-keys-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function keyFile(contents: string, mode = 0o600): string {
  const file = join(dir, "key.json");
  writeFileSync(file, contents);
  chmodSync(file, mode);
  return file;
}

describe("writeKeyFile", () => {
  it("writes an owner-only file in an owner-only directory", () => {
    const file = join(dir, "creds", "agent-a.testnet.json");
    writeKeyFile(file, { account_id: "a.testnet", public_key: "ed25519:x", private_key: SECRET });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "creds")).mode & 0o777).toBe(0o700);
    expect(readKeyFile(file)).toBe(SECRET);
  });

  it("never overwrites an existing key", () => {
    const file = join(dir, "k.json");
    writeKeyFile(file, { account_id: "a.testnet", public_key: "ed25519:x", private_key: SECRET });
    expect(() => writeKeyFile(file, { account_id: "a.testnet", public_key: "ed25519:y", private_key: SECRET })).toThrow(
      /refusing to overwrite/,
    );
  });

  it("refuses a path inside the repo", () => {
    expect(() => writeKeyFile(join(REPO_ROOT, "agent.json"), { account_id: "a", public_key: "", private_key: SECRET })).toThrow(
      /inside the repo/,
    );
  });
});

describe("readKeyFile", () => {
  it("does not leak file contents when the JSON is malformed", () => {
    const file = keyFile(`{"private_key": "${SECRET}"`);
    let caught: unknown;
    try {
      readKeyFile(file);
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(error.message).toContain(file);
    expect(error.message).not.toContain(SECRET.slice(8, 20));
    expect(error.cause).toBeUndefined();
  });

  it("warns when the key file is readable by group or others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readKeyFile(keyFile(JSON.stringify({ private_key: SECRET }), 0o644));
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/chmod 600/);
  });

  it("refuses a non-ed25519 key", () => {
    expect(() => readKeyFile(keyFile(JSON.stringify({ private_key: "secp256k1:abc" })))).toThrow(/not an ed25519 key/);
  });
});

describe("isInsideRepo", () => {
  it("resolves .. segments and symlinks", () => {
    expect(isInsideRepo(join(REPO_ROOT, "packages", "..", "key.json"))).toBe(true);
    expect(isInsideRepo(join(REPO_ROOT, "..", "elsewhere", "key.json"))).toBe(false);
    const link = join(dir, "repo-link");
    symlinkSync(REPO_ROOT, link);
    expect(isInsideRepo(join(link, "not-yet-created.json"))).toBe(true);
  });

  it("does not mistake a sibling directory with a common prefix for the repo", () => {
    expect(isInsideRepo(REPO_ROOT.replace(/\/$/, "") + "-other/key.json")).toBe(false);
  });

  it("assertOutsideRepo names what was refused", () => {
    expect(() => assertOutsideRepo(join(REPO_ROOT, "k.json"), "AGENT_KEY_FILE")).toThrow(/AGENT_KEY_FILE.*inside the repo/);
  });
});
