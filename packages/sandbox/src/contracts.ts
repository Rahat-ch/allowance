/**
 * Builds the contracts the sandbox deploys. Always builds: cargo is
 * incremental, and a stale wasm would silently test old code.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const CONTRACTS = {
  allowance: { dir: "allowance", wasm: "allowance/allowance.wasm" },
  signer: { dir: "mock-signer", wasm: "mock_signer/mock_signer.wasm" },
  usdc: { dir: "mock-usdc", wasm: "mock_usdc/mock_usdc.wasm" },
} as const;

export type ContractName = keyof typeof CONTRACTS;
export type Wasms = Record<ContractName, Uint8Array>;

export function buildContract(name: ContractName): Uint8Array {
  const { dir, wasm } = CONTRACTS[name];
  try {
    execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], {
      cwd: join(REPO_ROOT, "contracts", dir),
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`cargo near build failed for contracts/${dir}:\n${stderr}`);
  }
  return readFileSync(join(REPO_ROOT, "target", "near", wasm));
}

/** The last built wasm; run `buildContracts()` first (the test setup does). */
export function readContracts(): Wasms {
  const read = (name: ContractName) => readFileSync(join(REPO_ROOT, "target", "near", CONTRACTS[name].wasm));
  return { allowance: read("allowance"), signer: read("signer"), usdc: read("usdc") };
}

export function buildContracts(): Wasms {
  return { allowance: buildContract("allowance"), signer: buildContract("signer"), usdc: buildContract("usdc") };
}
