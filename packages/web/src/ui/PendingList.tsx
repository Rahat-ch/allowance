import { ownerCalls, type SpendRequest } from "../allowance.js";
import { formatTimestamp, formatUsdc, timeAgo, timeUntil } from "../format.js";
import type { ActionState } from "./hooks.js";

type Props = {
  pending: SpendRequest[];
  now: number;
  canAct: boolean;
  actions: ActionState;
};

/** Pending spends waiting for the Owner, and approved ones waiting for the Agent's Pickup. */
export function PendingList({ pending, now, canAct, actions }: Props) {
  return (
    <section className="panel">
      <h2>
        Pending spends <span className="count">{pending.length}</span>
      </h2>
      {pending.length === 0 ? (
        <p className="muted">Nothing waiting for you.</p>
      ) : (
        <div className="table-scroll">
        <table className="pending">
          <thead>
            <tr>
              <th>Amount</th>
              <th>Payee</th>
              <th>Memo</th>
              <th>Requested</th>
              <th>Time left</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => (
              <Row key={r.requestId} request={r} now={now} canAct={canAct} actions={actions} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

function Row({ request: r, now, canAct, actions }: { request: SpendRequest; now: number; canAct: boolean; actions: ActionState }) {
  const approveKey = `approve:${r.requestId}`;
  const rejectKey = `reject:${r.requestId}`;
  const waiting = actions.busy !== null;
  return (
    <>
      <tr>
        <td className="amount">{formatUsdc(r.amount)}</td>
        <td className="mono">{r.payee}</td>
        <td>{r.memo ?? <span className="muted">—</span>}</td>
        <td title={formatTimestamp(r.requestedAtNs)}>{timeAgo(r.requestedAtNs, now)}</td>
        <td>
          {r.status === "Approved" ? (
            <span title={r.pickupDeadlineNs ? formatTimestamp(r.pickupDeadlineNs) : undefined}>
              <span className="tag approved">Approved</span> Pickup deadline{" "}
              {r.pickupDeadlineNs ? timeUntil(r.pickupDeadlineNs, now) : "—"}
            </span>
          ) : (
            <span title={r.expiresAtNs ? formatTimestamp(r.expiresAtNs) : undefined}>
              Expires {r.expiresAtNs ? timeUntil(r.expiresAtNs, now) : "—"}
            </span>
          )}
        </td>
        <td className="actions">
          {r.status === "Pending" && (
            <>
              <button
                className="primary"
                disabled={!canAct || waiting}
                onClick={() => actions.run(approveKey, `Approve ${formatUsdc(r.amount)} to ${r.payee}`, ownerCalls.approve(r.requestId))}
              >
                {actions.busy === approveKey ? "Approving…" : "Approve"}
              </button>
              <button disabled={!canAct || waiting} onClick={() => actions.run(rejectKey, `Reject ${formatUsdc(r.amount)} to ${r.payee}`, ownerCalls.reject(r.requestId))}>
                {actions.busy === rejectKey ? "Rejecting…" : "Reject"}
              </button>
            </>
          )}
          {r.status === "Approved" && <span className="muted">Waiting for the Agent</span>}
        </td>
      </tr>
      <tr className="detail">
        <td colSpan={6}>
          <span className="mono muted">Request ID {r.requestId}</span>
        </td>
      </tr>
    </>
  );
}
