/**
 * `pnpm --filter deploy run allowance [-- --config <file>] [--name <name>] [--dry-run]`
 *
 * Creates a fresh, locked Allowance from a JSON config (allowance.config.example.json)
 * and verifies the lock. See deploy.ts for the steps. The Owner's key is read from
 * `~/.near-credentials/<network>/<owner>.json` (near-cli's format); the Agent's key is
 * written next to it as `agent-<allowance>.json` (0600). No key ever lives in the repo.
 *
 * Environment (from the repo's .env): ALLOWANCE_CONFIG (config path), OWNER_ACCOUNT_ID,
 * ALLOWANCE_NAME and NEAR_NETWORK override the file; command-line flags override both.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Account } from "near-api-js";
import { connect } from "./chain.js";
import { ConfigError, parseConfig, readConfigFile, type ConfigOverrides } from "./config.js";
import { deployAllowance, describePlan, describeResult, planDeploy } from "./deploy.js";
import { REPO_ROOT, defaultCredentialsDir, readKeyFile } from "./keys.js";

const USAGE = `usage: pnpm --filter deploy run allowance [-- --config <file>] [--name <name>] [--owner <account>] [--network testnet|mainnet|sandbox] [--dry-run]`;
export const ENV_FILE = join(REPO_ROOT, ".env");
export const DEFAULT_CONFIG = join(REPO_ROOT, "allowance.config.json");

export type CliArgs = { config?: string; dryRun: boolean; help: boolean; overrides: ConfigOverrides };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, help: false, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === "--") continue;
    else if (arg === "--dry-run" || arg === "--plan") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--config") args.config = value();
    else if (arg === "--name") args.overrides.name = value();
    else if (arg === "--owner") args.overrides.owner = value();
    else if (arg === "--network") args.overrides.network = value();
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return args;
}

/** Environment values first, command-line flags over them. Blank variables count as unset. */
export function mergeOverrides(env: NodeJS.ProcessEnv, cli: ConfigOverrides): ConfigOverrides {
  const pick = (name: string) => env[name]?.trim() || undefined;
  const merged: ConfigOverrides = {};
  const network = cli.network ?? pick("NEAR_NETWORK");
  const owner = cli.owner ?? pick("OWNER_ACCOUNT_ID");
  const name = cli.name ?? pick("ALLOWANCE_NAME");
  if (network) merged.network = network;
  if (owner) merged.owner = owner;
  if (name) merged.name = name;
  return merged;
}

/** Sets `name=value` in `.env`, replacing an existing line or appending one. */
export function setEnvValue(name: string, value: string, file = ENV_FILE): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
  writeFileSync(file, next);
}

/** Always builds: cargo is incremental, and a stale wasm would silently deploy old code. */
export function buildWasm(): Uint8Array {
  console.log("cargo near build non-reproducible-wasm (contracts/allowance)");
  execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], {
    cwd: join(REPO_ROOT, "contracts", "allowance"),
    stdio: ["ignore", "inherit", "inherit"],
  });
  return readFileSync(join(REPO_ROOT, "target", "near", "allowance", "allowance.wasm"));
}

/** True when this module is the script Node was started with, not an import. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  loadDotenv({ path: ENV_FILE, quiet: true });
  // pnpm runs the script in packages/deploy; resolve a relative path against where it was invoked.
  const configFile = resolve(process.env.INIT_CWD ?? process.cwd(), args.config ?? (process.env.ALLOWANCE_CONFIG?.trim() || DEFAULT_CONFIG));
  const { settings, warnings } = parseConfig(readConfigFile(configFile), mergeOverrides(process.env, args.overrides));
  console.log(`config ${configFile}`);

  const wasm = buildWasm();
  const chain = await connect(settings.network.rpcUrls);
  const credentialsDir = defaultCredentialsDir(settings.network.name);
  const ownerKeyFile = join(credentialsDir, `${settings.ownerId}.json`);
  const ownerKey = existsSync(ownerKeyFile) ? readKeyFile(ownerKeyFile) : undefined;
  const owner = new Account(settings.ownerId, chain.provider, ownerKey);
  const input = { settings, chain, owner, wasm, credentialsDir };

  const plan = await planDeploy(input, warnings);
  if (!ownerKey) plan.refusals.push(`no key for the Owner: ${ownerKeyFile} is missing (near-cli's credential format)`);
  console.log(`\n== plan${args.dryRun ? " (dry run: nothing is sent)" : ""}`);
  for (const line of describePlan(plan)) console.log(`  ${line}`);
  for (const warning of plan.warnings) console.warn(`  warning: ${warning}`);
  if (plan.refusals.length > 0) {
    throw new Error(`refusing to deploy:\n${plan.refusals.map((r) => `  - ${r}`).join("\n")}`);
  }
  if (args.dryRun) {
    console.log("\nDry run: the plan passes every check. Run again without --dry-run to deploy.");
    return;
  }

  const result = await deployAllowance(input, plan);
  setEnvValue("ALLOWANCE_ACCOUNT_ID", result.allowanceId);
  setEnvValue("AGENT_KEY_FILE", result.agentKeyFile);
  console.log(`\n== done: ${settings.allowanceId} is locked`);
  for (const line of describeResult(settings, result)) console.log(`  ${line}`);
  console.log(`\nWrote ALLOWANCE_ACCOUNT_ID and AGENT_KEY_FILE to ${ENV_FILE}.`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof ConfigError || error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
