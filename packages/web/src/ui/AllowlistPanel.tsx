import { useRef, useState, type FormEvent } from "react";
import { addPayeeCalls, isAccountId, ownerCalls, removalEffects, type AllowanceViews, type Snapshot, type SpendRequest } from "../allowance.js";
import { formatUsdc } from "../format.js";
import type { ActionState } from "./hooks.js";

type Props = { snapshot: Snapshot; views: AllowanceViews; canAct: boolean; actions: ActionState };

/** The Payees the Agent may pay: add (registering USDC storage if needed) and remove. */
export function AllowlistPanel({ snapshot, views, canAct, actions }: Props) {
  const [payee, setPayee] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const waiting = actions.busy !== null;
  const candidate = payee.trim().toLowerCase();
  const problem =
    candidate === ""
      ? null
      : !isAccountId(candidate)
        ? "Not a valid NEAR account ID."
        : snapshot.allowlist.includes(candidate)
          ? "Already on the Allowlist."
          : null;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!candidate || problem) return;
    const ok = await actions.run("add_payee", `Add ${candidate} to the Allowlist`, async () =>
      addPayeeCalls(snapshot.asset, candidate, await views.usdcRegistration(snapshot.asset, candidate)),
    );
    if (ok) setPayee("");
  }

  function askRemove(p: string) {
    setRemoving(p);
    dialog.current?.showModal();
  }

  async function remove() {
    dialog.current?.close();
    if (removing) await actions.run(`remove_payee:${removing}`, `Remove ${removing} from the Allowlist`, ownerCalls.removePayee(removing));
    setRemoving(null);
  }

  const effects = removing ? removalEffects(snapshot.pending, removing) : null;

  return (
    <section className="panel">
      <h2>
        Allowlist <span className="count">{snapshot.allowlist.length}</span>
      </h2>
      {snapshot.allowlist.length === 0 ? (
        <p className="muted">Empty: every Spend Request is Blocked until you add a Payee.</p>
      ) : (
        <ul className="payees">
          {snapshot.allowlist.map((p) => {
            const open = snapshot.pending.filter((r) => r.payee === p).length;
            return (
              <li key={p}>
                <span className="mono">{p}</span>
                {open > 0 && <span className="muted small"> {open} open spend{open === 1 ? "" : "s"}</span>}
                <button className="danger" disabled={!canAct || waiting} onClick={() => askRemove(p)}>
                  {actions.busy === `remove_payee:${p}` ? "Removing…" : "Remove…"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="inline-form" onSubmit={add}>
        <input placeholder="payee.near" value={payee} onChange={(e) => setPayee(e.target.value)} spellCheck={false} />
        <button type="submit" className="primary" disabled={!canAct || waiting || !candidate || problem !== null}>
          {actions.busy === "add_payee" ? "Adding…" : "Add Payee"}
        </button>
      </form>
      {problem && <p className="error small">{problem}</p>}
      <p className="muted small">
        If the Payee has no USDC storage yet, adding it also registers that storage (0.00125 NEAR on USDC, paid by you), so payments to it don't fail.
      </p>

      <dialog ref={dialog} className="confirm" onClose={() => setRemoving(null)}>
        <h3>Remove {removing} from the Allowlist?</h3>
        <p>The Agent can't pay it any more. Its open spends end now:</p>
        {effects && effects.rejected.length + effects.cancelled.length === 0 ? (
          <p className="muted">It has no Pending or approved spends, so nothing is cancelled.</p>
        ) : (
          effects && (
            <ul>
              {effects.rejected.map((r) => (
                <Affected key={r.requestId} r={r} what="Pending: Rejected" />
              ))}
              {effects.cancelled.map((r) => (
                <Affected key={r.requestId} r={r} what="Approved, not picked up: Cancelled" />
              ))}
            </ul>
          )
        )}
        <p className="muted small">Their Reservations and Held funds are released. Signed Payments already issued stay valid until they expire.</p>
        <div className="dialog-buttons">
          <button onClick={() => dialog.current?.close()} autoFocus>
            Cancel
          </button>
          <button className="danger" onClick={remove}>
            Remove Payee
          </button>
        </div>
      </dialog>
    </section>
  );
}

function Affected({ r, what }: { r: SpendRequest; what: string }) {
  return (
    <li>
      <strong>{formatUsdc(r.amount)}</strong> {r.memo ? `"${r.memo}" ` : ""}
      <span className="muted small">
        ({what}) <span className="mono">{r.requestId}</span>
      </span>
    </li>
  );
}
