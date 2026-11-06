/**
 * MCP server configuration from environment variables. The server holds only the Agent's
 * function-call key, read from a file outside the repository (or the environment).
 *
 *   ALLOWANCE_ACCOUNT_ID       The Allowance contract account (required)
 *   ALLOWANCE_AGENT_KEY_FILE   near-cli style JSON credential file ({"private_key": "ed25519:..."})
 *                              or a file holding just "ed25519:..."; must be outside the repo
 *   ALLOWANCE_AGENT_KEY        the key itself, "ed25519:..." (instead of the file)
 *   ALLOWANCE_NETWORK          near:testnet (default) or near:mainnet ("testnet"/"mainnet" also work)
 *   NEAR_RPC_URL               defaults to FastNEAR for the network
 *   ALLOWANCE_SIGN_TIMEOUT_MS  how long allowance_pay waits for a Signed Payment (default 90000)
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2 } from "@x402/near";

export type KeyPairString = `ed25519:${string}`;
export type NearNetwork = typeof NEAR_TESTNET_CAIP2 | typeof NEAR_MAINNET_CAIP2;

/** FastNEAR: rpc.testnet.near.org is deprecated and slow enough to outlast a short Signed Payment. */
export const DEFAULT_RPC_URLS: Record<NearNetwork, string> = {
  [NEAR_TESTNET_CAIP2]: "https://test.rpc.fastnear.com",
  [NEAR_MAINNET_CAIP2]: "https://rpc.mainnet.fastnear.com",
};

export type ServerConfig = {
  allowanceId: string;
  network: NearNetwork;
  rpcUrl: string;
  agentKey: KeyPairString;
  signTimeoutMs: number;
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const get = (name: string) => env[name]?.trim() || undefined;
  const allowanceId = get("ALLOWANCE_ACCOUNT_ID");
  if (!allowanceId) throw new Error("ALLOWANCE_ACCOUNT_ID is required");
  const network = parseNetwork(get("ALLOWANCE_NETWORK") ?? NEAR_TESTNET_CAIP2);

  const keyFile = get("ALLOWANCE_AGENT_KEY_FILE");
  const inline = get("ALLOWANCE_AGENT_KEY");
  if (keyFile && inline) throw new Error("set ALLOWANCE_AGENT_KEY_FILE or ALLOWANCE_AGENT_KEY, not both");
  if (!keyFile && !inline) throw new Error("ALLOWANCE_AGENT_KEY_FILE (or ALLOWANCE_AGENT_KEY) is required");
  const agentKey = keyFile ? readAgentKeyFile(keyFile) : asSecretKey(inline!, "ALLOWANCE_AGENT_KEY");

  const timeout = get("ALLOWANCE_SIGN_TIMEOUT_MS");
  const signTimeoutMs = timeout ? Number(timeout) : 90_000;
  if (!Number.isInteger(signTimeoutMs) || signTimeoutMs <= 0) throw new Error(`ALLOWANCE_SIGN_TIMEOUT_MS must be a positive integer, got ${timeout}`);

  return { allowanceId, network, rpcUrl: get("NEAR_RPC_URL") ?? DEFAULT_RPC_URLS[network], agentKey, signTimeoutMs };
}

export function parseNetwork(value: string): NearNetwork {
  const v = value.includes(":") ? value : `near:${value}`;
  if (v !== NEAR_TESTNET_CAIP2 && v !== NEAR_MAINNET_CAIP2) {
    throw new Error(`ALLOWANCE_NETWORK must be near:testnet or near:mainnet, got ${value}`);
  }
  return v;
}

/**
 * Reads the Agent's key from a near-cli credential file or a bare "ed25519:..." file.
 * Refuses files inside the repository and never echoes file contents in errors.
 */
export function readAgentKeyFile(file: string, repoRoot = REPO_ROOT): KeyPairString {
  if (isInside(repoRoot, file)) throw new Error(`refusing to read a key file inside the repo: ${file}`);
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    // stderr: stdout carries the MCP protocol.
    console.error(`warning: ${file} is readable by group or others; run chmod 600 ${file}`);
  }
  const text = readFileSync(file, "utf8").trim();
  if (text.startsWith("ed25519:")) return asSecretKey(text, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // No `cause`: a JSON SyntaxError quotes the text around the error, i.e. the key.
    throw new Error(`${file}: not a JSON credential file or an ed25519 key`);
  }
  const key = (parsed as { private_key?: unknown } | null)?.private_key;
  if (typeof key !== "string") throw new Error(`${file}: no private_key`);
  return asSecretKey(key, file);
}

function asSecretKey(value: string, where: string): KeyPairString {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error(`${where}: not an ed25519 secret key`);
  return value as KeyPairString;
}

function isInside(root: string, path: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
