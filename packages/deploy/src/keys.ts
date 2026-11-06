/**
 * Key files in near-cli's format (`{account_id, public_key, private_key}`), kept in
 * `~/.near-credentials/<network>` with owner-only permissions. Keys are never read
 * from or written to this repository.
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type KeyPairString = `ed25519:${string}`;

export type CredentialFile = { account_id: string; public_key: string; private_key: string };

/** `~/.near-credentials/<network>`, near-cli's default. */
export function defaultCredentialsDir(network: string): string {
  return join(homedir(), ".near-credentials", network);
}

/**
 * `path` with symlinks and `..` resolved. A path that does not exist yet is resolved
 * through its nearest existing ancestor, so a key about to be written is judged by
 * where it will really land.
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

/** Creates `dir` if needed and keeps it owner-only (0700). */
export function ensurePrivateDir(dir: string): void {
  assertOutsideRepo(dir, "credentials directory");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Reads a near-cli credential file and returns its secret key. Refuses files inside the
 * repo, warns when group or others can read the file, and never echoes the file's
 * contents in an error.
 */
export function readKeyFile(file: string): KeyPairString {
  assertOutsideRepo(file);
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(
      `warning: ${file} has mode ${mode.toString(8).padStart(4, "0")}, so group or others can access it; run chmod 600 ${file}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Deliberately no `cause`: a JSON SyntaxError quotes the text around the error, i.e. the key.
    throw new Error(`${file}: not a valid JSON credential file`);
  }
  const key = typeof parsed === "object" && parsed !== null ? (parsed as { private_key?: unknown }).private_key : undefined;
  if (typeof key !== "string") throw new Error(`${file}: no private_key`);
  if (!key.startsWith("ed25519:")) throw new Error(`${file}: private_key is not an ed25519 key`);
  return key as KeyPairString;
}

/**
 * Writes a new credential file, owner-only (0600). Refuses paths inside the repo and
 * never overwrites an existing file.
 */
export function writeKeyFile(file: string, contents: CredentialFile): void {
  assertOutsideRepo(file);
  ensurePrivateDir(dirname(file));
  try {
    writeFileSync(file, JSON.stringify(contents, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite the existing key file ${file}`);
    }
    throw error;
  }
}
