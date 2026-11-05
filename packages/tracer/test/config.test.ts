import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, assertOutsideRepo, isInsideRepo, readKeyFile } from "../src/config.js";

const SECRET = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tracer-config-"));
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

describe("readKeyFile", () => {
  it("returns the private key", () => {
    const file = keyFile(JSON.stringify({ account_id: "a.testnet", public_key: "ed25519:x", private_key: SECRET }));
    expect(readKeyFile(file)).toBe(SECRET);
  });

  it("does not leak file contents when the JSON is malformed", () => {
    const file = keyFile(`{"private_key": "${SECRET}"`);
    let caught: unknown;
    try {
      readKeyFile(file);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain(file);
    expect(error.message).not.toContain(SECRET.slice(8, 20));
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? "").not.toContain(SECRET.slice(8, 20));
  });

  it("warns when the key file is readable by group or others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readKeyFile(keyFile(JSON.stringify({ private_key: SECRET }), 0o644));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/chmod 600/);
  });

  it("does not warn for an owner-only key file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readKeyFile(keyFile(JSON.stringify({ private_key: SECRET }), 0o600));
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a key file inside the repo", () => {
    expect(() => readKeyFile(join(REPO_ROOT, "agent.json"))).toThrow(/inside the repo/);
  });
});

describe("isInsideRepo", () => {
  it("resolves .. segments", () => {
    expect(isInsideRepo(join(REPO_ROOT, "packages", "..", "key.json"))).toBe(true);
    expect(isInsideRepo(join(REPO_ROOT, "..", "elsewhere", "key.json"))).toBe(false);
  });

  it("resolves relative paths against the working directory", () => {
    const cwd = process.cwd();
    try {
      process.chdir(REPO_ROOT);
      expect(isInsideRepo("key.json")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("follows symlinks into the repo", () => {
    const link = join(dir, "repo-link");
    symlinkSync(REPO_ROOT, link);
    expect(isInsideRepo(join(link, "not-yet-created.json"))).toBe(true);
  });

  it("is false for the temp dir", () => {
    expect(isInsideRepo(join(dir, "key.json"))).toBe(false);
  });

  it("does not mistake a sibling directory with a common prefix for the repo", () => {
    expect(isInsideRepo(REPO_ROOT.replace(/\/$/, "") + "-other/key.json")).toBe(false);
  });
});

describe("assertOutsideRepo", () => {
  it("names the resolved path", () => {
    expect(() => assertOutsideRepo(join(REPO_ROOT, "a", "..", "k.json"), "AGENT_KEY_FILE")).toThrow(
      /AGENT_KEY_FILE.*inside the repo/,
    );
  });
});
