/**
 * Who is signed in and how their Owner calls get signed. Two ways in:
 * - a NEAR wallet through @near-wallet-selector (testnet and mainnet): every call is
 *   confirmed in the wallet, which attaches the 1 yoctoNEAR the contract demands;
 * - a pasted secret key, on the local sandbox only, so the page can be smoke-tested
 *   against `pnpm --filter web sandbox` where no wallet can reach.
 */
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";
import type { InjectedWallet, WalletSelector } from "@near-wallet-selector/core";
import type { OwnerCall } from "./allowance.js";
import type { Config } from "./config.js";

export type Session = {
  accountId: string;
  /** Where the signatures come from, for display ("MyNearWallet", "sandbox key"). */
  via: string;
  /**
   * Signs and sends Owner calls, one transaction each and in order (a wallet asks once for
   * the lot where it can). Rejects with the first failure; later calls aren't sent.
   */
  send(...calls: OwnerCall[]): Promise<void>;
  signOut(): Promise<void>;
};

export type WalletOption = { id: string; name: string; iconUrl: string };

/** Methods the wallet's sign-in key may call without a confirmation: stopping the Agent. */
const SIGN_IN_METHODS = ["pause"];

function toAction(call: OwnerCall) {
  return actionCreators.functionCall(call.methodName, call.args, call.gas, call.deposit);
}

function receiverOf(call: OwnerCall, allowanceId: string): string {
  return call.receiverId ?? allowanceId;
}

/**
 * Some wallets hand back a failed transaction's outcome instead of throwing; turn a
 * contract panic into an error whose message carries it (see `explainError`).
 */
export function assertSucceeded(outcome: unknown): void {
  const status = (outcome as { status?: unknown } | null | undefined)?.status;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(`Transaction failed: ${JSON.stringify((status as { Failure: unknown }).Failure)}`);
  }
}

// ---- wallet selector ------------------------------------------------------------------

export class Wallets {
  private constructor(
    private readonly selector: WalletSelector,
    private readonly allowanceId: string,
  ) {}

  /** Loaded lazily so sandbox-only use never pulls the wallet modules. */
  static async setUp(config: Config): Promise<Wallets> {
    if (config.network === "sandbox") throw new Error("wallets don't reach the sandbox");
    const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }, { setupIntearWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/my-near-wallet"),
      import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/intear-wallet"),
    ]);
    const selector = await setupWalletSelector({
      network: config.network,
      modules: [setupMyNearWallet(), setupMeteorWallet(), setupIntearWallet()],
      allowMultipleSelectors: true,
    });
    return new Wallets(selector, config.allowanceId);
  }

  options(): WalletOption[] {
    return this.selector.store
      .getState()
      .modules.filter((m) => m.metadata.available)
      .map((m) => ({ id: m.id, name: m.metadata.name, iconUrl: m.metadata.iconUrl }));
  }

  /** The session restored from a previous visit, if the wallet still has one. */
  async current(): Promise<Session | null> {
    const state = this.selector.store.getState();
    const account = state.accounts.find((a) => a.active) ?? state.accounts[0];
    if (!account || !state.selectedWalletId) return null;
    return this.session(state.selectedWalletId, account.accountId);
  }

  async signIn(walletId: string): Promise<Session> {
    const wallet = await this.selector.wallet<InjectedWallet>(walletId);
    const accounts = await wallet.signIn({ contractId: this.allowanceId, methodNames: SIGN_IN_METHODS });
    const accountId = accounts[0]?.accountId;
    if (!accountId) throw new Error("The wallet returned no account.");
    return this.session(walletId, accountId);
  }

  private async session(walletId: string, accountId: string): Promise<Session> {
    const wallet = await this.selector.wallet<InjectedWallet>(walletId);
    const name = this.selector.store.getState().modules.find((m) => m.id === walletId)?.metadata.name ?? walletId;
    return {
      accountId,
      via: name,
      send: async (...calls) => {
        const [only] = calls;
        if (calls.length === 1 && only) {
          assertSucceeded(
            await wallet.signAndSendTransaction({ signerId: accountId, receiverId: receiverOf(only, this.allowanceId), actions: [toAction(only)] }),
          );
          return;
        }
        const outcomes = await wallet.signAndSendTransactions({
          transactions: calls.map((c) => ({ signerId: accountId, receiverId: receiverOf(c, this.allowanceId), actions: [toAction(c)] })),
        });
        for (const outcome of outcomes ?? []) assertSucceeded(outcome);
      },
      signOut: () => wallet.signOut(),
    };
  }
}

// ---- sandbox key ----------------------------------------------------------------------

const SANDBOX_KEY = "allowance-sandbox-owner";

/** Signs with a pasted secret key. Only offered when the page points at a local sandbox. */
export function sandboxSession(config: Config, accountId: string, secretKey: string): Session {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(secretKey as KeyPairString));
  const account = new Account(accountId, provider, signer);
  try {
    sessionStorage.setItem(SANDBOX_KEY, JSON.stringify({ accountId, secretKey }));
  } catch {
    // Not remembered: the Owner pastes the key again after a reload.
  }
  return {
    accountId,
    via: "sandbox key",
    send: async (...calls) => {
      for (const c of calls) {
        await account.signAndSendTransaction({ receiverId: receiverOf(c, config.allowanceId), actions: [toAction(c)] });
      }
    },
    signOut: async () => {
      try {
        sessionStorage.removeItem(SANDBOX_KEY);
      } catch {
        // nothing remembered
      }
    },
  };
}

export function rememberedSandboxSession(config: Config): Session | null {
  try {
    const raw = sessionStorage.getItem(SANDBOX_KEY);
    if (!raw) return null;
    const { accountId, secretKey } = JSON.parse(raw) as { accountId: string; secretKey: string };
    return sandboxSession(config, accountId, secretKey);
  } catch {
    return null;
  }
}
