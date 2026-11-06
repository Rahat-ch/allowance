/**
 * Which chain and Allowance the page talks to. Read from the URL (`?network=`, `?rpc=`,
 * `?allowance=`) first, then from what this browser remembered, then defaults.
 */

export type NetworkId = "testnet" | "mainnet" | "sandbox";

export type Config = {
  network: NetworkId;
  rpcUrl: string;
  /** The Allowance contract account; empty until the Owner enters one. */
  allowanceId: string;
};

export const DEFAULT_RPC: Record<NetworkId, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
  sandbox: "http://127.0.0.1:3030",
};

export const EXPLORER: Record<NetworkId, string | null> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
  sandbox: null,
};

const STORAGE_KEY = "allowance-owner-page";

function isNetwork(value: string | null | undefined): value is NetworkId {
  return value === "testnet" || value === "mainnet" || value === "sandbox";
}

/** Resolves the config: URL query wins over what was remembered, which wins over defaults. */
export function resolveConfig(query: URLSearchParams, remembered: Partial<Config> | null): Config {
  const queryNetwork = query.get("network");
  const network: NetworkId = isNetwork(queryNetwork) ? queryNetwork : isNetwork(remembered?.network) ? remembered.network : "testnet";
  // A remembered RPC only applies to the network it was remembered for.
  const rememberedRpc = remembered?.network === network ? remembered.rpcUrl : undefined;
  return {
    network,
    rpcUrl: query.get("rpc") || rememberedRpc || DEFAULT_RPC[network],
    allowanceId: (query.get("allowance") ?? (remembered?.network === network ? remembered.allowanceId : "") ?? "").trim(),
  };
}

export function loadConfig(): Config {
  return resolveConfig(new URLSearchParams(window.location.search), readRemembered());
}

export function rememberConfig(config: Config): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage blocked (private mode): the URL still carries the config.
  }
  const url = new URL(window.location.href);
  url.searchParams.set("network", config.network);
  url.searchParams.set("allowance", config.allowanceId);
  if (config.rpcUrl === DEFAULT_RPC[config.network]) url.searchParams.delete("rpc");
  else url.searchParams.set("rpc", config.rpcUrl);
  window.history.replaceState(null, "", url);
}

function readRemembered(): Partial<Config> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Config>) : null;
  } catch {
    return null;
  }
}
