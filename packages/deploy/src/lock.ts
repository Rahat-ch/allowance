/**
 * The lock (ADR 0004), checked from what the chain reports. Pure: the deploy fetches
 * the access-key lists and views, this decides whether they add up to a locked Allowance.
 */

/** The only method the Agent's function-call key may call. */
export const AGENT_METHOD = "request_spend";

/** An access key as RPC `view_access_key_list` returns it. */
export type AccessKeyInfo = {
  public_key: string;
  access_key: {
    permission:
      | "FullAccess"
      | { FunctionCall: { allowance?: string | null; receiver_id: string; method_names: string[] } }
      | Record<string, unknown>;
  };
};

export type LockEvidence = {
  allowanceId: string;
  /** Access keys on the Allowance account. */
  allowanceKeys: AccessKeyInfo[];
  /** The contract's `get_agent_key`. */
  agentKey: string;
  payerAccountId: string;
  /** Access keys on the Payer Account. */
  payerKeys: AccessKeyInfo[];
  /** The contract's `payer_keys`, in path order (`x402/0`, `x402/1`, ...). */
  payerKeysView: string[];
  /** The signer's `derived_public_key` for the Allowance at each path, same order. */
  derivedKeys: string[];
  /** Keys the Payer Account was created with, if known. */
  expectedKeyCount?: number;
  /** Code hashes, if the caller wants the deployed code checked against the build. */
  codeHash?: { deployed: string; built: string };
};

export type LockReport = { locked: boolean; problems: string[]; checks: string[] };

function describe(permission: AccessKeyInfo["access_key"]["permission"]): string {
  return permission === "FullAccess" ? "full access" : JSON.stringify(permission);
}

export function verifyLock(e: LockEvidence): LockReport {
  const problems: string[] = [];
  const checks: string[] = [];

  // ---- the Allowance account ----
  const fullAccess = e.allowanceKeys.filter((k) => k.access_key.permission === "FullAccess");
  if (fullAccess.length > 0) {
    problems.push(`${e.allowanceId} has full-access keys: ${fullAccess.map((k) => k.public_key).join(", ")}`);
  } else {
    checks.push(`${e.allowanceId} has no full-access key`);
  }
  const others = e.allowanceKeys.filter((k) => k.public_key !== e.agentKey && k.access_key.permission !== "FullAccess");
  for (const k of others) {
    problems.push(`${e.allowanceId} has a key that is not the Agent's: ${k.public_key} (${describe(k.access_key.permission)})`);
  }
  const agent = e.allowanceKeys.find((k) => k.public_key === e.agentKey);
  if (!agent) {
    problems.push(`the Agent's key ${e.agentKey} (get_agent_key) is not on ${e.allowanceId}`);
  } else {
    const permission = agent.access_key.permission;
    const call =
      typeof permission === "object" && "FunctionCall" in permission
        ? (permission.FunctionCall as { receiver_id?: unknown; method_names?: unknown })
        : undefined;
    const methods = Array.isArray(call?.method_names) ? call.method_names : undefined;
    if (!call || call.receiver_id !== e.allowanceId || methods?.length !== 1 || methods[0] !== AGENT_METHOD) {
      problems.push(
        `the Agent's key must be a function-call key for ${e.allowanceId} limited to ["${AGENT_METHOD}"], ` +
          `but it is ${describe(permission)}`,
      );
    } else {
      checks.push(`the Agent's key ${e.agentKey} may call only ${AGENT_METHOD} on ${e.allowanceId}`);
    }
  }
  if (others.length === 0 && fullAccess.length === 0 && agent) {
    checks.push(`the Agent's key is the only key on ${e.allowanceId}`);
  }
  if (e.codeHash) {
    if (e.codeHash.deployed !== e.codeHash.built) {
      problems.push(`${e.allowanceId} runs code ${e.codeHash.deployed}, not the build ${e.codeHash.built}`);
    } else {
      checks.push(`${e.allowanceId} runs the built contract (${e.codeHash.built})`);
    }
  }

  // ---- the Payer Account ----
  if (e.payerKeysView.length === 0) {
    problems.push(`payer_keys() is empty: the Payer Account was not created`);
  } else if (e.expectedKeyCount !== undefined && e.payerKeysView.length !== e.expectedKeyCount) {
    problems.push(`payer_keys() lists ${e.payerKeysView.length} keys, expected ${e.expectedKeyCount}`);
  }
  if (new Set(e.payerKeysView).size !== e.payerKeysView.length) problems.push("payer_keys() lists a key twice");
  const recorded = new Set(e.payerKeysView);
  const onChain = new Set(e.payerKeys.map((k) => k.public_key));
  const extra = e.payerKeys.filter((k) => !recorded.has(k.public_key));
  const missing = e.payerKeysView.filter((k) => !onChain.has(k));
  for (const k of extra) {
    problems.push(`${e.payerAccountId} has a key the Allowance did not derive: ${k.public_key} (${describe(k.access_key.permission)})`);
  }
  for (const k of missing) problems.push(`payer_keys() lists ${k}, which is not on ${e.payerAccountId}`);
  if (e.payerKeysView.length > 0 && extra.length === 0 && missing.length === 0) {
    checks.push(`${e.payerAccountId} holds exactly the ${e.payerKeysView.length} keys in payer_keys()`);
  }
  for (const k of e.payerKeys) {
    if (recorded.has(k.public_key) && k.access_key.permission !== "FullAccess") {
      problems.push(`${e.payerAccountId} key ${k.public_key} is not full-access, so x402 would refuse its Signed Payments`);
    }
  }
  const mismatched = e.payerKeysView.filter((k, i) => e.derivedKeys[i] !== k);
  if (e.derivedKeys.length !== e.payerKeysView.length || mismatched.length > 0) {
    problems.push(
      `payer_keys() does not match the signer's derived_public_key for x402/0..${e.payerKeysView.length - 1}: ` +
        `recorded ${JSON.stringify(e.payerKeysView)}, derived ${JSON.stringify(e.derivedKeys)}`,
    );
  } else if (e.payerKeysView.length > 0) {
    checks.push(`every Payer Account key is the signer's derived key for ${e.allowanceId} (x402/0..${e.payerKeysView.length - 1})`);
  }

  return { locked: problems.length === 0, problems, checks };
}
