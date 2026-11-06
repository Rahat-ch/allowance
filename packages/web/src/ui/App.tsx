import { useEffect, useMemo, useState } from "react";
import { AllowanceViews } from "../allowance.js";
import { loadConfig, rememberConfig, type Config } from "../config.js";
import { rememberedSandboxSession, Wallets, type Session } from "../wallet.js";
import { BudgetPanel } from "./BudgetPanel.js";
import { ConfigBar } from "./ConfigBar.js";
import { ControlPanel } from "./ControlPanel.js";
import { useNow, useOwnerActions, useSnapshot } from "./hooks.js";
import { PendingList } from "./PendingList.js";
import { SignIn } from "./SignIn.js";
import { StatusBanner } from "./StatusBanner.js";

export function App() {
  const [config, setConfig] = useState<Config>(loadConfig);
  const [wallets, setWallets] = useState<Wallets | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  const views = useMemo(
    () => (config.allowanceId ? new AllowanceViews(config.rpcUrl, config.allowanceId) : null),
    [config.rpcUrl, config.allowanceId],
  );
  const { snapshot, error, refresh } = useSnapshot(views);
  const actions = useOwnerActions(session, refresh);
  const now = useNow();

  // Sign-in is per network and Allowance: set it up again whenever they change.
  useEffect(() => {
    let cancelled = false;
    setWallets(null);
    setSession(null);
    if (!config.allowanceId) return;
    if (config.network === "sandbox") {
      setSession(rememberedSandboxSession(config));
      return;
    }
    Wallets.setUp(config)
      .then(async (w) => {
        if (cancelled) return;
        setWallets(w);
        const restored = await w.current();
        if (!cancelled) setSession(restored);
      })
      .catch((e) => console.error("wallet selector failed to load", e));
    return () => {
      cancelled = true;
    };
  }, [config]);

  function applyConfig(next: Config) {
    rememberConfig(next);
    setConfig(next);
  }

  const owner = snapshot?.owner ?? null;
  const canAct = session !== null && owner !== null && session.accountId === owner;

  return (
    <main>
      <header>
        <h1>Allowance</h1>
        <span className="muted">Owner page</span>
      </header>
      <ConfigBar config={config} onChange={applyConfig} />

      {!config.allowanceId ? (
        <p className="muted">Enter the Allowance account to open it, or link here with ?allowance=…</p>
      ) : (
        <>
          <SignIn config={config} wallets={wallets} session={session} owner={owner} onSession={setSession} />
          {error && <div className="alert error">Can't read {config.allowanceId}: {error}</div>}
          {actions.failure && (
            <div className="alert error" role="alert">
              <strong>{actions.failure.label} failed.</strong> {actions.failure.message}{" "}
              <button className="link" onClick={actions.dismiss}>
                Dismiss
              </button>
            </div>
          )}
          {snapshot && (
            <>
              <StatusBanner paused={snapshot.paused} revoked={snapshot.revoked} />
              <PendingList pending={snapshot.pending} now={now} canAct={canAct} actions={actions} />
              <div className="columns">
                <BudgetPanel budget={snapshot.budget} now={now} />
                <ControlPanel snapshot={snapshot} canAct={canAct} actions={actions} />
              </div>
              {/* Management (#15) slots in here: Policy, Allowlist, Withdraw, Agent key, recent Spend Requests. */}
            </>
          )}
          {!snapshot && !error && <p className="muted">Loading {config.allowanceId}…</p>}
        </>
      )}
    </main>
  );
}
