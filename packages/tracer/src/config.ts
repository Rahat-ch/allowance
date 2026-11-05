/**
 * Shared settings for the tracer scripts: testnet constants, `.env` loading,
 * and key files in `~/.near-credentials`. Keys are only ever read from or
 * written to the home directory, never to the repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { NEAR_TESTNET_CAIP2, getDefaultAsset } from "@x402/near";

export const NETWORK = NEAR_TESTNET_CAIP2;

/** Primary testnet RPC first, then the fallback. */
export const RPC_URLS = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"] as const;

/** Circle USDC on NEAR testnet, as the x402 NEAR package lists it. */
export const USDC_TESTNET = getDefaultAsset(NETWORK).asset;

/** MPC signer contract and its Ed25519 domain (docs/notes/chain-signatures.md §1, §3). */
export const MPC_SIGNER_ID = "v1.signer-prod.testnet";
export const MPC_ED25519_DOMAIN_ID = 1;

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const ENV_FILE = join(REPO_ROOT, ".env");
export const CREDENTIALS_DIR = join(homedir(), ".near-credentials", "testnet");

export function loadEnv(): void {
  loadDotenv({ path: ENV_FILE, quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set; add it to ${ENV_FILE}`);
  }
  return value;
}

export type KeyPairString = `ed25519:${string}`;

type CredentialFile = { account_id?: string; public_key: string; private_key: string };

function asSecretKey(value: string, file: string): KeyPairString {
  if (!value.startsWith("ed25519:")) {
    throw new Error(`${file}: private_key is not an ed25519 key`);
  }
  return value as KeyPairString;
}

/** Reads a near-cli style credential file and returns its secret key. */
export function readKeyFile(file: string): KeyPairString {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CredentialFile>;
  if (typeof parsed.private_key !== "string") {
    throw new Error(`${file}: no private_key`);
  }
  return asSecretKey(parsed.private_key, file);
}

/** `~/.near-credentials/testnet/<accountId>.json`. */
export function accountKeyFile(accountId: string): string {
  return join(CREDENTIALS_DIR, `${accountId}.json`);
}

export function readAccountKey(accountId: string): KeyPairString {
  return readKeyFile(accountKeyFile(accountId));
}

/** Writes a credential file with owner-only permissions. Refuses paths inside the repo. */
export function writeKeyFile(file: string, contents: CredentialFile): void {
  if (file.startsWith(REPO_ROOT)) {
    throw new Error(`refusing to write a key inside the repo: ${file}`);
  }
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(contents, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/** Sets `name=value` in `.env`, replacing an existing line or appending one. */
export function setEnvValue(name: string, value: string): void {
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
  writeFileSync(ENV_FILE, next);
  process.env[name] = value;
}

export function txLink(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

export function accountLink(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}
