/**
 * The deploy config: a JSON file (see allowance.config.example.json) plus overrides
 * from the environment and the command line. `parseConfig` validates it all at once
 * and resolves it into the settings the deploy runs with.
 */
import { readFileSync } from "node:fs";
import { NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2, getDefaultAsset } from "@x402/near";
import { poolSizing, type PoolSizing } from "./pool.js";
import { NEAR, parseNear, parseUsdc } from "./units.js";

export type NetworkName = "testnet" | "mainnet" | "sandbox";

export type NetworkSettings = {
  name: NetworkName;
  /** Tried in order; the first that answers is used for the whole run. */
  rpcUrls: string[];
  /** Chain Signatures signer contract. */
  signerId: string;
  /** The signer's Ed25519 domain. */
  domainId: number;
  /** Circle USDC (or the sandbox's mock). */
  usdcContractId: string;
  /** Block explorer base URL; none in the sandbox. */
  explorerUrl?: string;
};

/** Testnet and mainnet facts: docs/notes/chain-signatures.md §1 and §3; USDC as @x402/near lists it. */
export const NETWORKS: Record<"testnet" | "mainnet", NetworkSettings> = {
  testnet: {
    name: "testnet",
    // FastNEAR first: rpc.testnet.near.org is deprecated and ~4x slower.
    rpcUrls: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
    signerId: "v1.signer-prod.testnet",
    domainId: 1,
    usdcContractId: getDefaultAsset(NEAR_TESTNET_CAIP2).asset,
    explorerUrl: "https://testnet.nearblocks.io",
  },
  mainnet: {
    name: "mainnet",
    rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
    signerId: "v1.signer",
    domainId: 1,
    usdcContractId: getDefaultAsset(NEAR_MAINNET_CAIP2).asset,
    explorerUrl: "https://nearblocks.io",
  },
};

/** The Policy as the contract takes it: USDC base units as decimal strings. */
export type ContractPolicy = {
  daily_cap: string;
  auto_limit: string;
  hard_ceiling: string;
  velocity_limit: number;
  max_timeout_blocks: number;
};

/** The contract's `MAX_TIMEOUT_BLOCKS_LIMIT`. */
export const MAX_TIMEOUT_BLOCKS_LIMIT = 600;

/** What the config file holds. Amounts are decimal strings in USDC or NEAR. */
export type RawConfig = {
  network?: string;
  /** The Owner account; the Allowance is created as `<name>.<owner>`. */
  owner?: string;
  /** The Allowance sub-account's name. Use a new one for every deploy. */
  name?: string;
  /** Optional per-network overrides (required for `sandbox`). */
  rpcUrls?: string[];
  signerId?: string;
  domainId?: number;
  usdcContractId?: string;
  policy?: {
    dailyCap?: string;
    autoLimit?: string;
    hardCeiling?: string;
    velocityLimit?: number;
    maxTimeoutBlocks?: number;
  };
  payees?: string[];
  /** Derived keys on the Payer Account (1..32); see pool.ts. */
  keyCount?: number;
  fund?: {
    /** USDC the Owner deposits into the Allowance with ft_transfer_call. */
    usdc?: string;
    /** NEAR the Allowance account is created with: contract storage, Payer Account, signing deposits, gas. */
    near?: string;
  };
  /** Gas allowance of the Agent's function-call key, in NEAR (default 1). */
  agentGasNear?: string;
};

/** Values from the environment or command line; they win over the file. */
export type ConfigOverrides = { network?: string; owner?: string; name?: string };

export type DeploySettings = {
  network: NetworkSettings;
  ownerId: string;
  name: string;
  allowanceId: string;
  payerAccountId: string;
  policy: ContractPolicy;
  payees: string[];
  keyCount: number;
  pool: PoolSizing;
  fundUsdc: bigint;
  fundNear: bigint;
  agentAllowance: bigint;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid deploy config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ACCOUNT_LABEL = /^([a-z\d]+[-_])*[a-z\d]+$/;

/** NEAR account id rules: 2-64 characters, lowercase labels separated by dots. */
export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);
}

export function readConfigFile(file: string): RawConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read deploy config ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as RawConfig;
  } catch (error) {
    throw new Error(`deploy config ${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Validates the config and resolves it; throws ConfigError listing every problem. */
export function parseConfig(raw: RawConfig, overrides: ConfigOverrides = {}): { settings: DeploySettings; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  const amount = <T>(what: string, value: unknown, parse: (s: string) => T): T | undefined => {
    if (typeof value !== "string") {
      problems.push(`${what} must be a decimal string, e.g. "1.5"`);
      return undefined;
    }
    try {
      return parse(value);
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`);
      return undefined;
    }
  };
  const integer = (what: string, value: unknown, min: number, max: number): number | undefined => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${what} must be an integer in ${min}..${max}`);
      return undefined;
    }
    return value;
  };

  // ---- network ----
  const networkName = overrides.network ?? raw.network ?? "testnet";
  let network: NetworkSettings | undefined;
  if (networkName === "testnet" || networkName === "mainnet") {
    const preset = NETWORKS[networkName];
    network = {
      ...preset,
      rpcUrls: raw.rpcUrls ?? preset.rpcUrls,
      signerId: raw.signerId ?? preset.signerId,
      domainId: raw.domainId ?? preset.domainId,
      usdcContractId: raw.usdcContractId ?? preset.usdcContractId,
    };
  } else if (networkName === "sandbox") {
    if (!raw.rpcUrls?.length || !raw.signerId || !raw.usdcContractId) {
      problems.push("network sandbox needs rpcUrls, signerId and usdcContractId");
    } else {
      network = {
        name: "sandbox",
        rpcUrls: raw.rpcUrls,
        signerId: raw.signerId,
        domainId: raw.domainId ?? 1,
        usdcContractId: raw.usdcContractId,
      };
    }
  } else {
    problems.push(`network must be testnet, mainnet or sandbox, not ${JSON.stringify(networkName)}`);
  }
  if (network) {
    if (!Array.isArray(network.rpcUrls) || network.rpcUrls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) {
      problems.push("rpcUrls must be http(s) URLs");
    }
    for (const [what, id] of [["signerId", network.signerId], ["usdcContractId", network.usdcContractId]] as const) {
      if (!isValidAccountId(id)) problems.push(`${what} ${JSON.stringify(id)} is not a valid account id`);
    }
    integer("domainId", network.domainId, 0, 2 ** 32);
  }

  // ---- accounts ----
  const ownerId = overrides.owner ?? raw.owner ?? "";
  const name = overrides.name ?? raw.name ?? "";
  if (!isValidAccountId(ownerId)) problems.push(`owner ${JSON.stringify(ownerId)} is not a valid account id`);
  if (!ACCOUNT_LABEL.test(name)) {
    problems.push(`name ${JSON.stringify(name)} must be one account-id label (lowercase letters, digits, - or _), no dots`);
  }
  const allowanceId = `${name}.${ownerId}`;
  const payerAccountId = `pay.${allowanceId}`;
  if (ownerId && name && payerAccountId.length > 64) {
    problems.push(`${payerAccountId} (the Payer Account) is longer than 64 characters; use a shorter name`);
  }

  // ---- Policy ----
  const p = raw.policy ?? {};
  const dailyCap = amount("policy.dailyCap", p.dailyCap, parseUsdc);
  const autoLimit = amount("policy.autoLimit", p.autoLimit, parseUsdc);
  const hardCeiling = amount("policy.hardCeiling", p.hardCeiling, parseUsdc);
  const velocityLimit = integer("policy.velocityLimit", p.velocityLimit, 1, 2 ** 32 - 1);
  const maxTimeoutBlocks = integer("policy.maxTimeoutBlocks", p.maxTimeoutBlocks, 1, MAX_TIMEOUT_BLOCKS_LIMIT);
  if (dailyCap === 0n) problems.push("policy.dailyCap must be positive");
  if (hardCeiling === 0n) problems.push("policy.hardCeiling must be positive");
  if (autoLimit !== undefined && hardCeiling !== undefined && autoLimit > hardCeiling) {
    problems.push("policy.autoLimit must not exceed policy.hardCeiling");
  }
  if (autoLimit !== undefined && dailyCap !== undefined && autoLimit > dailyCap) {
    problems.push("policy.autoLimit must not exceed policy.dailyCap");
  }
  if (hardCeiling !== undefined && dailyCap !== undefined && hardCeiling > dailyCap) {
    warnings.push("policy.hardCeiling is above policy.dailyCap, so no single spend can reach the Hard Ceiling");
  }

  // ---- Payees ----
  const payees = raw.payees ?? [];
  if (!Array.isArray(payees)) {
    problems.push("payees must be a list of account ids");
  } else {
    for (const payee of payees) {
      if (typeof payee !== "string" || !isValidAccountId(payee)) {
        problems.push(`payee ${JSON.stringify(payee)} is not a valid account id`);
      } else if (payee === allowanceId || payee === payerAccountId) {
        problems.push(`payee ${payee} is the Allowance or its Payer Account`);
      }
    }
    if (new Set(payees).size !== payees.length) problems.push("payees has duplicates");
    if (payees.length === 0) warnings.push("no payees: an empty Allowlist blocks every Spend Request");
  }

  // ---- key pool ----
  const keyCount = integer("keyCount", raw.keyCount, 1, 32);
  let pool: PoolSizing | undefined;
  if (keyCount !== undefined && velocityLimit !== undefined && maxTimeoutBlocks !== undefined) {
    pool = poolSizing({ velocityLimit, maxTimeoutBlocks, keyCount });
    if (pool.verdict === "refuse") problems.push(pool.message!);
    if (pool.verdict === "warn") warnings.push(pool.message!);
  }

  // ---- funding ----
  const fundUsdc = amount("fund.usdc", raw.fund?.usdc, parseUsdc);
  const fundNear = amount("fund.near", raw.fund?.near, parseNear);
  const agentAllowance = amount("agentGasNear", raw.agentGasNear ?? "1", parseNear);
  if (fundUsdc === 0n) warnings.push("fund.usdc is 0: the Allowance starts with no USDC to spend");
  if (fundNear !== undefined && fundNear < NEAR) problems.push("fund.near must be at least 1 NEAR (contract storage alone needs more)");
  if (agentAllowance === 0n) problems.push("agentGasNear must be positive");

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    settings: {
      network: network!,
      ownerId,
      name,
      allowanceId,
      payerAccountId,
      policy: {
        daily_cap: dailyCap!.toString(),
        auto_limit: autoLimit!.toString(),
        hard_ceiling: hardCeiling!.toString(),
        velocity_limit: velocityLimit!,
        max_timeout_blocks: maxTimeoutBlocks!,
      },
      payees: payees as string[],
      keyCount: keyCount!,
      pool: pool!,
      fundUsdc: fundUsdc!,
      fundNear: fundNear!,
      agentAllowance: agentAllowance!,
    },
    warnings,
  };
}
