/** Says plainly when the Agent can't spend: Revoked (for good) or Paused (until unpause). */
export function StatusBanner({ paused, revoked }: { paused: boolean; revoked: boolean }) {
  if (revoked) {
    return (
      <div className="banner revoked" role="status">
        <strong>Revoked.</strong> The Agent's key is deleted and every Spend Request is Blocked. Spending again needs a new
        Allowance.
      </div>
    );
  }
  if (paused) {
    return (
      <div className="banner paused" role="status">
        <strong>Paused.</strong> Every new Spend Request is Blocked and no Signed Payment is issued. You can still approve or
        reject; approved spends are picked up only after you unpause.
      </div>
    );
  }
  return (
    <div className="banner active" role="status">
      <strong>Active.</strong> The Agent can spend within the Policy.
    </div>
  );
}
