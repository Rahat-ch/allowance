import type { Budget } from "../allowance.js";
import { formatNear, formatTimestamp, formatUsdc, timeUntil } from "../format.js";

/** Below this the Allowance may stall signing deposits and gas (spec story 6). */
const LOW_NEAR = 500_000_000_000_000_000_000_000n; // 0.5 NEAR

export function BudgetPanel({ budget, now }: { budget: Budget; now: number }) {
  const usedPct = budget.dailyCap > 0n ? Number((budget.usedInWindow * 1000n) / budget.dailyCap) / 10 : 0;
  return (
    <section className="panel">
      <h2>Budget</h2>
      <div className="meter" aria-label={`Daily Cap ${usedPct}% used`}>
        <div className="meter-fill" style={{ width: `${Math.min(100, usedPct)}%` }} />
      </div>
      <dl className="stats">
        <Stat label="Used in last 24h" hint="Includes Reservations for Pending and approved spends">
          {formatUsdc(budget.usedInWindow)} <span className="muted">of {formatUsdc(budget.dailyCap)} Daily Cap</span>
        </Stat>
        <Stat label="Available now">{formatUsdc(budget.available)}</Stat>
        <Stat label="Capacity frees" hint="When the oldest Reservation in the window falls out of the rolling 24 hours">
          {budget.nextReleaseNs === null ? (
            <span className="muted">nothing reserved</span>
          ) : (
            <span title={formatTimestamp(budget.nextReleaseNs)}>{timeUntil(budget.nextReleaseNs, now)}</span>
          )}
        </Stat>
        <Stat label="Velocity (last hour)">
          {budget.velocityUsed} <span className="muted">of {budget.velocityLimit} spends</span>
        </Stat>
        <Stat label="USDC balance">{formatUsdc(budget.usdcBalance)}</Stat>
        <Stat label="Held" hint="Pending and approved spends not yet paid">
          {formatUsdc(budget.held)}
        </Stat>
        <Stat label="Withdrawable">{formatUsdc(budget.withdrawable)}</Stat>
        <Stat label="NEAR balance" hint="For storage, signing deposits and gas">
          <span className={budget.nearBalance < LOW_NEAR ? "warn" : undefined}>{formatNear(budget.nearBalance)}</span>
        </Stat>
      </dl>
    </section>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="stat" title={hint}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
