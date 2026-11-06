import { useEffect, useState } from "react";
import { describeBlockedReason, explainError, type AllowanceViews, type SpendRequest } from "../allowance.js";
import { formatTimestamp, formatUsdc, timeAgo } from "../format.js";

const PAGE = 20;

type Props = {
  views: AllowanceViews;
  /** The Allowance's page on an explorer, or null (sandbox). */
  explorerUrl: string | null;
  /** Changes whenever the page re-reads the Allowance, so this list refreshes with it. */
  refreshKey: unknown;
  now: number;
};

/** Every stored Spend Request, newest first, a page at a time. */
export function RecentRequests({ views, explorerUrl, refreshKey, now }: Props) {
  const [from, setFrom] = useState(0);
  const [page, setPage] = useState<SpendRequest[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // One extra row says whether an older page exists.
    views
      .listRequests(from, PAGE + 1)
      .then((rows) => {
        if (cancelled) return;
        setPage(rows.slice(0, PAGE));
        setHasOlder(rows.length > PAGE);
        setError(null);
      })
      .catch((e) => !cancelled && setError(explainError(e)));
    return () => {
      cancelled = true;
    };
  }, [views, from, refreshKey]);

  return (
    <section className="panel">
      <h2>Recent Spend Requests</h2>
      <p className="muted small">
        Newest first. The contract doesn't keep transaction hashes, so explorer links open the Allowance account, where every Spend
        Request, decision and Signed Payment shows as a transaction and event. Blocked attempts beyond the hourly storage budget appear
        only there.
        {explorerUrl && (
          <>
            {" "}
            <a href={explorerUrl} target="_blank" rel="noreferrer">
              Open in explorer
            </a>
          </>
        )}
      </p>
      {error && <p className="error">{error}</p>}
      {page && page.length === 0 && from === 0 && <p className="muted">No Spend Requests yet.</p>}
      {page && page.length > 0 && (
        <div className="table-scroll">
          <table className="pending">
            <thead>
              <tr>
                <th>When</th>
                <th>Amount</th>
                <th>Payee</th>
                <th>Memo</th>
                <th>Outcome</th>
                <th>Now</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {page.map((r) => (
                <tr key={r.requestId} className="row-line">
                  <td title={formatTimestamp(r.requestedAtNs)}>{timeAgo(r.requestedAtNs, now)}</td>
                  <td className="amount">{formatUsdc(r.amount)}</td>
                  <td className="mono">{r.payee}</td>
                  <td>{r.memo ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`tag ${r.outcome.toLowerCase()}`}>{r.outcome}</span>
                    {r.blockedReason && <div className="small muted">{describeBlockedReason(r.blockedReason)}</div>}
                  </td>
                  <td>{r.status === r.outcome ? <span className="muted">—</span> : r.status}</td>
                  <td>
                    <span className="mono muted small" title={r.requestId}>
                      {r.requestId.slice(0, 12)}…
                    </span>{" "}
                    {explorerUrl && (
                      <a href={explorerUrl} target="_blank" rel="noreferrer" className="small">
                        explorer
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="controls pager">
        <button disabled={from === 0} onClick={() => setFrom(Math.max(0, from - PAGE))}>
          Newer
        </button>
        <span className="muted small">
          {page && page.length > 0 ? `${from + 1}–${from + page.length}` : ""}
        </span>
        <button disabled={!hasOlder} onClick={() => setFrom(from + PAGE)}>
          Older
        </button>
      </div>
    </section>
  );
}
