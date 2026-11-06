import { useState, type FormEvent } from "react";
import { DEFAULT_RPC, type Config, type NetworkId } from "../config.js";

/** Network, RPC and which Allowance to open. Applied on submit, then remembered. */
export function ConfigBar({ config, onChange }: { config: Config; onChange: (next: Config) => void }) {
  const [draft, setDraft] = useState(config);

  function submit(event: FormEvent) {
    event.preventDefault();
    onChange({ ...draft, allowanceId: draft.allowanceId.trim(), rpcUrl: draft.rpcUrl.trim() || DEFAULT_RPC[draft.network] });
  }

  function setNetwork(network: NetworkId) {
    setDraft({ ...draft, network, rpcUrl: DEFAULT_RPC[network] });
  }

  return (
    <form className="config" onSubmit={submit}>
      <label>
        Network
        <select value={draft.network} onChange={(e) => setNetwork(e.target.value as NetworkId)}>
          <option value="testnet">testnet</option>
          <option value="mainnet">mainnet</option>
          <option value="sandbox">local sandbox</option>
        </select>
      </label>
      <label className="grow">
        RPC
        <input value={draft.rpcUrl} onChange={(e) => setDraft({ ...draft, rpcUrl: e.target.value })} spellCheck={false} />
      </label>
      <label className="grow">
        Allowance account
        <input
          value={draft.allowanceId}
          placeholder="allowance.owner.testnet"
          onChange={(e) => setDraft({ ...draft, allowanceId: e.target.value })}
          spellCheck={false}
        />
      </label>
      <button type="submit">Open</button>
    </form>
  );
}
