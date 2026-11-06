import { useState, type FormEvent } from "react";
import { ownerCalls, policyProblems, type Policy } from "../allowance.js";
import { formatDuration, formatUsdc, parseUsdc, usdcInput } from "../format.js";
import type { ActionState } from "./hooks.js";

type Draft = { dailyCap: string; autoLimit: string; hardCeiling: string; velocityLimit: string; maxTimeoutBlocks: string };

function toDraft(p: Policy): Draft {
  return {
    dailyCap: usdcInput(p.dailyCap),
    autoLimit: usdcInput(p.autoLimit),
    hardCeiling: usdcInput(p.hardCeiling),
    velocityLimit: String(p.velocityLimit),
    maxTimeoutBlocks: String(p.maxTimeoutBlocks),
  };
}

/** The draft as a Policy, or the problems that stop it being one. */
function fromDraft(d: Draft): { policy: Policy | null; problems: string[] } {
  const dailyCap = parseUsdc(d.dailyCap);
  const autoLimit = parseUsdc(d.autoLimit);
  const hardCeiling = parseUsdc(d.hardCeiling);
  const problems: string[] = [];
  if (dailyCap === null) problems.push("Daily Cap must be a dollar amount.");
  if (autoLimit === null) problems.push("Auto Limit must be a dollar amount.");
  if (hardCeiling === null) problems.push("Hard Ceiling must be a dollar amount.");
  if (dailyCap === null || autoLimit === null || hardCeiling === null) return { policy: null, problems };
  const policy = { dailyCap, autoLimit, hardCeiling, velocityLimit: Number(d.velocityLimit), maxTimeoutBlocks: Number(d.maxTimeoutBlocks) };
  const more = policyProblems(policy);
  return { policy: more.length ? null : policy, problems: more };
}

/** The full Policy in one view, and an editor for it. */
export function PolicyPanel({ policy, canAct, actions }: { policy: Policy; canAct: boolean; actions: ActionState }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const checked = draft ? fromDraft(draft) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!checked?.policy) return;
    if (await actions.run("set_policy", "Save the Policy", ownerCalls.setPolicy(checked.policy))) setDraft(null);
  }

  if (!draft) {
    return (
      <section className="panel">
        <h2>Policy</h2>
        <dl className="stats">
          <Item label="Daily Cap" hint="Most that may be reserved over any rolling 24 hours">
            {formatUsdc(policy.dailyCap)}
          </Item>
          <Item label="Auto Limit" hint="Largest spend approved without you">
            {formatUsdc(policy.autoLimit)}
          </Item>
          <Item label="Hard Ceiling" hint="Largest single spend allowed at all">
            {formatUsdc(policy.hardCeiling)}
          </Item>
          <Item label="Velocity Limit">{policy.velocityLimit} spends / hour</Item>
          <Item label="Signed Payment validity" hint="Longest a Signed Payment may stay valid (~1 block per second)">
            {policy.maxTimeoutBlocks} blocks (~{formatDuration(policy.maxTimeoutBlocks * 1000)})
          </Item>
        </dl>
        <div className="controls">
          <button disabled={!canAct} onClick={() => setDraft(toDraft(policy))}>
            Edit Policy
          </button>
        </div>
      </section>
    );
  }

  const field = (key: keyof Draft, label: string, unit: string) => (
    <label>
      {label}
      <span className="with-unit">
        {unit === "$" && <span className="muted">$</span>}
        <input value={draft[key]} inputMode="decimal" onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        {unit !== "$" && <span className="muted">{unit}</span>}
      </span>
    </label>
  );

  return (
    <section className="panel">
      <h2>Edit Policy</h2>
      <form className="form-grid" onSubmit={submit}>
        {field("dailyCap", "Daily Cap", "$")}
        {field("autoLimit", "Auto Limit", "$")}
        {field("hardCeiling", "Hard Ceiling", "$")}
        {field("velocityLimit", "Velocity Limit", "spends / hour")}
        {field("maxTimeoutBlocks", "Signed Payment validity", "blocks")}
        <p className="muted small span">
          A new Policy applies to new Spend Requests. Approvals and Pickups re-check the current Hard Ceiling and Allowlist.
        </p>
        {checked && checked.problems.length > 0 && (
          <ul className="error small span">
            {checked.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="controls span">
          <button type="submit" className="primary" disabled={!canAct || !checked?.policy || actions.busy !== null}>
            {actions.busy === "set_policy" ? "Saving…" : "Save Policy"}
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function Item({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="stat" title={hint}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
