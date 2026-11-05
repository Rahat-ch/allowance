/**
 * Shared settings for the tracer scripts: testnet constants, `.env` loading,
 * and key files in `~/.near-credentials`. Keys are only ever read from or
 * written to the home directory, never to the repo.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { NEAR_TESTNET_CAIP2, getDefaultAsset } from "@x402/near";

export const NETWORK = NEAR_TESTNET_CAIP2;

/** FastNEAR first: rpc.testnet.near.org is deprecated and ~4x slower, which can outlast a 60-block Signed Payment. */
export const RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] as const;

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

/**
 * `path` with symlinks and `..` resolved. A path that does not exist yet is
 * resolved through its nearest existing ancestor, so a key about to be
 * written is judged by where it will really land.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
  }
}

/** True when `path` resolves to somewhere inside this repository. */
export function isInsideRepo(path: string): boolean {
  const rel = relative(realPath(REPO_ROOT), realPath(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Throws unless `path` resolves outside the repository; keys must never live in it. */
export function assertOutsideRepo(path: string, what = "key file"): void {
  if (isInsideRepo(path)) {
    throw new Error(`refusing to use a ${what} inside the repo: ${realPath(path)}`);
  }
}

/** Creates the credentials directory if needed and keeps it owner-only (0700). */
export function ensureCredentialsDir(): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(dirname(CREDENTIALS_DIR), 0o700);
  chmodSync(CREDENTIALS_DIR, 0o700);
}

/**
 * Reads a near-cli style credential file and returns its secret key. Refuses
 * files inside the repo, warns when group or others can read the file, and
 * never echoes the file's contents in an error.
 */
export function readKeyFile(file: string): KeyPairString {
  assertOutsideRepo(file);
  if (dirname(realPath(file)) === realPath(CREDENTIALS_DIR)) {
    ensureCredentialsDir();
  }
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(
      `warning: ${file} has mode ${mode.toString(8).padStart(4, "0")}, so group or others can access it; run chmod 600 ${file}`,
    );
  }
  let parsed: Partial<CredentialFile>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CredentialFile>;
  } catch {
    // Deliberately no `cause`: a JSON SyntaxError quotes the text around the error, i.e. the key.
    throw new Error(`${file}: not a valid JSON credential file`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.private_key !== "string") {
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
  assertOutsideRepo(file);
  ensureCredentialsDir();
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

/**
 * True when this module's importer is the script Node was started with, so
 * scripts run `main` only when executed, not when imported by tests.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

export function txLink(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

export function accountLink(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}
