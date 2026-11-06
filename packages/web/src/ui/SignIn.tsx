import { useState, type FormEvent } from "react";
import { explainError } from "../allowance.js";
import type { Config } from "../config.js";
import { sandboxSession, type Session, type WalletOption, type Wallets } from "../wallet.js";

type Props = {
  config: Config;
  wallets: Wallets | null;
  session: Session | null;
  owner: string | null;
  onSession: (session: Session | null) => void;
};

/** Who is signed in, and whether they are this Allowance's Owner. */
export function SignIn({ config, wallets, session, owner, onSession }: Props) {
  const [error, setError] = useState<string | null>(null);

  if (session) {
    const isOwner = owner !== null && session.accountId === owner;
    return (
      <div className="signin">
        <span>
          Signed in as <strong>{session.accountId}</strong> <span className="muted">via {session.via}</span>
        </span>
        {owner !== null && !isOwner && <span className="warn">Not the Owner ({owner}): controls are disabled.</span>}
        <button
          onClick={async () => {
            await session.signOut().catch(() => undefined);
            onSession(null);
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="signin">
      {config.network === "sandbox" ? (
        <SandboxKeyForm config={config} owner={owner} onSession={onSession} />
      ) : wallets ? (
        <WalletButtons
          options={wallets.options()}
          onPick={async (id) => {
            setError(null);
            try {
              onSession(await wallets.signIn(id));
            } catch (e) {
              setError(explainError(e));
            }
          }}
        />
      ) : (
        <span className="muted">Loading wallets…</span>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function WalletButtons({ options, onPick }: { options: WalletOption[]; onPick: (id: string) => void }) {
  return (
    <>
      <span>Sign in as the Owner:</span>
      {options.map((o) => (
        <button key={o.id} onClick={() => onPick(o.id)} className="wallet">
          <img src={o.iconUrl} alt="" width={18} height={18} />
          {o.name}
        </button>
      ))}
    </>
  );
}

/** Sandbox only: no wallet reaches a local chain, so the Owner's key is pasted instead. */
function SandboxKeyForm({ config, owner, onSession }: { config: Config; owner: string | null; onSession: (s: Session) => void }) {
  const [accountId, setAccountId] = useState(owner ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onSession(sandboxSession(config, accountId.trim() || owner || "", secretKey.trim()));
    } catch (e) {
      setError(explainError(e));
    }
  }

  return (
    <form onSubmit={submit} className="sandbox-key">
      <span>Sandbox sign-in:</span>
      <input placeholder={owner ?? "owner account"} value={accountId} onChange={(e) => setAccountId(e.target.value)} spellCheck={false} />
      <input
        placeholder="ed25519:… secret key"
        type="password"
        value={secretKey}
        onChange={(e) => setSecretKey(e.target.value)}
        spellCheck={false}
      />
      <button type="submit" disabled={!secretKey.trim()}>
        Use key
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
