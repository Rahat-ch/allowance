import { useRef } from "react";
import { ownerCalls, type Snapshot } from "../allowance.js";
import { formatDuration } from "../format.js";
import type { ActionState } from "./hooks.js";

/** Pause, unpause and Revoke. */
export function ControlPanel({ snapshot, canAct, actions }: { snapshot: Snapshot; canAct: boolean; actions: ActionState }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const waiting = actions.busy !== null;
  const { paused, revoked } = snapshot;
  const open = snapshot.pending.length;
  // Signed Payments are valid for at most the Policy's max timeout (~1 block per second).
  const longestValidity = formatDuration(snapshot.policy.maxTimeoutBlocks * 1000);

  async function revoke() {
    dialog.current?.close();
    await actions.run("revoke", "Revoke the Agent", ownerCalls.revoke());
  }

  return (
    <section className="panel">
      <h2>Control</h2>
      {revoked ? (
        <p className="muted">The Agent is revoked. Spending again needs a new Allowance.</p>
      ) : (
        <div className="controls">
          {paused ? (
            <button
              className="primary"
              disabled={!canAct || waiting}
              onClick={() => actions.run("unpause", "Unpause", ownerCalls.unpause())}
            >
              {actions.busy === "unpause" ? "Unpausing…" : "Unpause"}
            </button>
          ) : (
            <button disabled={!canAct || waiting} onClick={() => actions.run("pause", "Pause", ownerCalls.pause())}>
              {actions.busy === "pause" ? "Pausing…" : "Pause"}
            </button>
          )}
          <button className="danger" disabled={!canAct || waiting} onClick={() => dialog.current?.showModal()}>
            {actions.busy === "revoke" ? "Revoking…" : "Revoke Agent…"}
          </button>
          <p className="muted small">
            {paused
              ? "Unpausing lets the Agent submit Spend Requests and pick up approved spends again."
              : "Pause stops every new Spend Request and Signed Payment until you unpause. You can still approve or reject."}
          </p>
        </div>
      )}

      <dialog ref={dialog} className="confirm">
        <h3>Revoke the Agent permanently?</h3>
        <ul>
          <li>The Agent's key is deleted. This can't be undone: spending again needs a new Allowance.</li>
          <li>
            {open === 0
              ? "There are no Pending or approved spends to cancel."
              : `${open} Pending or approved-but-not-picked-up spend${open === 1 ? " is" : "s are"} cancelled and their Reservations released.`}
          </li>
          <li>
            <strong>Signed Payments already issued can't be cancelled.</strong> They stay valid until they expire, within{" "}
            {longestValidity} of being issued, and a Payee can still collect them until then.
          </li>
        </ul>
        <p className="muted small">If you only want to stop spending for now, Pause instead.</p>
        <div className="dialog-buttons">
          <button onClick={() => dialog.current?.close()} autoFocus>
            Cancel
          </button>
          <button className="danger" onClick={revoke}>
            Revoke Agent
          </button>
        </div>
      </dialog>
    </section>
  );
}
