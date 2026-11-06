import { useState, type FormEvent } from "react";
import { ownerCalls, withdrawProblem, type Snapshot } from "../allowance.js";
import { formatUsdc, parseUsdc, usdcInput } from "../format.js";
import type { ActionState } from "./hooks.js";

/** Withdraw USDC not Held for Pending or approved spends back to the Owner. */
export function FundsPanel({ snapshot, canAct, actions }: { snapshot: Snapshot; canAct: boolean; actions: ActionState }) {
  const [amount, setAmount] = useState("");
  const { withdrawable, held } = snapshot.budget;
  const parsed = parseUsdc(amount);
  const problem = amount.trim() === "" ? null : withdrawProblem(parsed, withdrawable);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed === null || withdrawProblem(parsed, withdrawable)) return;
    if (await actions.run("withdraw", `Withdraw ${formatUsdc(parsed)}`, ownerCalls.withdraw(parsed))) setAmount("");
  }

  return (
    <section className="panel">
      <h2>Withdraw</h2>
      <p>
        <strong>{formatUsdc(withdrawable)}</strong> withdrawable <span className="muted small">({formatUsdc(held)} Held for open spends)</span>
      </p>
      <form className="inline-form" onSubmit={submit}>
        <span className="with-unit">
          <span className="muted">$</span>
          <input value={amount} inputMode="decimal" placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
        </span>
        <button type="button" disabled={withdrawable === 0n} onClick={() => setAmount(usdcInput(withdrawable))}>
          Max
        </button>
        <button
          type="submit"
          className="primary"
          disabled={!canAct || actions.busy !== null || parsed === null || withdrawProblem(parsed, withdrawable) !== null}
        >
          {actions.busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
        </button>
      </form>
      {problem && <p className="error small">{problem}</p>}
      <p className="muted small">USDC goes to the Owner account, {snapshot.owner}.</p>
    </section>
  );
}
