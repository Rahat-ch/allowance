import { useCallback, useEffect, useRef, useState } from "react";
import { AllowanceViews, explainError, type OwnerCall, type Snapshot } from "../allowance.js";
import type { Session } from "../wallet.js";

export const POLL_MS = 5_000;

export type SnapshotState = {
  snapshot: Snapshot | null;
  /** The last read's failure; the previous snapshot stays on screen. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

/** Reads the whole Allowance now and every POLL_MS while the tab is visible. */
export function useSnapshot(views: AllowanceViews | null): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!views) return;
    const mine = generation.current;
    setLoading(true);
    try {
      const next = await views.snapshot();
      if (mine !== generation.current) return;
      setSnapshot(next);
      setError(null);
    } catch (e) {
      if (mine !== generation.current) return;
      setError(explainError(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [views]);

  useEffect(() => {
    generation.current += 1;
    setSnapshot(null);
    setError(null);
    if (!views) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [views, refresh]);

  return { snapshot, error, loading, refresh };
}

/** The wall clock, ticking every second, for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export type Calls = OwnerCall | OwnerCall[] | (() => Promise<OwnerCall[]>);

export type ActionState = {
  /** Key of the action in flight, e.g. "approve:req_123" or "pause". */
  busy: string | null;
  /** The last failure: what was tried ("Approve $15.00 to payee.near") and why it failed. */
  failure: { label: string; message: string } | null;
  /** `calls`: one call, several (sent in order), or a lookup that decides them first. */
  run: (key: string, label: string, calls: Calls) => Promise<boolean>;
  dismiss: () => void;
};

/**
 * Sends Owner calls through the signed-in session, one at a time. Refreshes the
 * snapshot after every attempt, so a stale page catches up whether the call worked or not.
 */
export function useOwnerActions(session: Session | null, refresh: () => Promise<void>): ActionState {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<ActionState["failure"]>(null);

  const run = useCallback(
    async (key: string, label: string, calls: Calls) => {
      if (!session) return false;
      setBusy(key);
      setFailure(null);
      try {
        const list = typeof calls === "function" ? await calls() : Array.isArray(calls) ? calls : [calls];
        await session.send(...list);
        return true;
      } catch (e) {
        console.error(e);
        setFailure({ label, message: explainError(e) });
        return false;
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [session, refresh],
  );

  return { busy, failure, run, dismiss: () => setFailure(null) };
}
