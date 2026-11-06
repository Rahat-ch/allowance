import { useState, type FormEvent } from "react";
import { KeyPair } from "@near-js/crypto";
import { DEFAULT_AGENT_ALLOWANCE, isPublicKey, ownerCalls, type Snapshot } from "../allowance.js";
import { formatNear, parseNear } from "../format.js";
import type { ActionState } from "./hooks.js";

/**
 * Replace the Agent's function-call key, e.g. when its gas allowance runs out. The key can
 * be generated here; its secret is shown once, for the Owner to hand to the Agent.
 */
export function AgentKeyPanel({ snapshot, canAct, actions }: { snapshot: Snapshot; canAct: boolean; actions: ActionState }) {
  const [publicKey, setPublicKey] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [gas, setGas] = useState(formatNear(DEFAULT_AGENT_ALLOWANCE).replace(" NEAR", ""));
  const allowance = parseNear(gas);
  const keyOk = isPublicKey(publicKey);
  const problem =
    publicKey.trim() && !keyOk
      ? "Not an ed25519 public key (ed25519:…)."
      : publicKey.trim() === snapshot.agentKey
        ? "That's the current key."
        : allowance === null || allowance <= 0n
          ? "Gas allowance must be a positive NEAR amount."
          : null;

  function generate() {
    const pair = KeyPair.fromRandom("ed25519");
    setPublicKey(pair.getPublicKey().toString());
    setSecret(pair.toString());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!keyOk || problem || allowance === null) return;
    const ok = await actions.run("replace_agent_key", "Replace the Agent key", ownerCalls.replaceAgentKey(publicKey.trim(), allowance));
    if (ok) setPublicKey("");
  }

  if (snapshot.revoked) {
    return (
      <section className="panel">
        <h2>Agent key</h2>
        <p className="muted">The Agent is revoked; its key can't be replaced. Spending again needs a new Allowance.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Agent key</h2>
      <p className="small">
        Current: <span className="mono">{snapshot.agentKey}</span>
      </p>
      <form className="form-grid" onSubmit={submit}>
        <label className="span">
          New public key
          <span className="with-unit">
            <input
              value={publicKey}
              placeholder="ed25519:…"
              spellCheck={false}
              onChange={(e) => {
                setPublicKey(e.target.value);
                setSecret(null);
              }}
            />
            <button type="button" onClick={generate}>
              Generate
            </button>
          </span>
        </label>
        <label>
          Gas allowance
          <span className="with-unit">
            <input value={gas} inputMode="decimal" onChange={(e) => setGas(e.target.value)} />
            <span className="muted">NEAR</span>
          </span>
        </label>
        {secret && (
          <div className="alert warn-box span small">
            <strong>Give this secret key to the Agent now; it isn't stored anywhere and won't be shown again.</strong>
            <div className="mono">{secret}</div>
          </div>
        )}
        {problem && <p className="error small span">{problem}</p>}
        <p className="muted small span">
          The old key is deleted and the new one may only call <span className="mono">request_spend</span>, spending at most the gas
          allowance.
        </p>
        <div className="controls span">
          <button type="submit" className="primary" disabled={!canAct || actions.busy !== null || !keyOk || problem !== null}>
            {actions.busy === "replace_agent_key" ? "Replacing…" : "Replace Agent key"}
          </button>
        </div>
      </form>
    </section>
  );
}
