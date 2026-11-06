/**
 * Ticket #16: the testnet proof run. Env-gated: does nothing unless PROOF_TESTNET=1.
 *
 * Uses a locked Allowance deployed with `pnpm --filter deploy run allowance`, the real
 * Chain Signatures signer, Circle testnet USDC, the demo seller and the official
 * `@x402/near` facilitator (unmodified, in process, with our relayer). The Agent acts only
 * through the Allowance MCP server's tools, holding only its function-call key.
 *
 *   1. Approved: a $0.10 call is paid; the Payee gets exactly $0.10.
 *   2. Blocked: a seller paying an account not on the Allowlist; nothing moves.
 *   3. Pending: a $1.00 report waits; the Owner approves; the Agent resumes; paid.
 *
 * Env (from the repo .env): ALLOWANCE_ACCOUNT_ID, AGENT_KEY_FILE, OWNER_ACCOUNT_ID,
 * RELAYER_ACCOUNT_ID, PAYEE_ACCOUNT_ID. Owner and relayer keys come from
 * ~/.near-credentials/testnet/<id>.json. Deploy transactions: docs/proof/deploy.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { x402Facilitator } from "@x402/core/facilitator";
import type { SupportedResponse } from "@x402/core/types";
import { NEAR_TESTNET_CAIP2, createFacilitatorNearSigner, getDefaultAsset } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import { AllowanceClient, createAllowanceServer, nearAllowance, readAgentKeyFile } from "allowance-mcp";
import { config as loadDotenv } from "dotenv";
import { Account, JsonRpcProvider } from "near-api-js";
import { startSeller } from "seller";
import { renderProof, validateProof, type Proof, type ProofStep, type ProofTx } from "./record.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const PROOF_JSON = join(REPO, "docs/proof/testnet.json");
export const PROOF_MD = join(REPO, "docs/proof/testnet.md");
const RPC = "https://test.rpc.fastnear.com";
const SIGNER = "v1.signer-prod.testnet";
const USDC = getDefaultAsset(NEAR_TESTNET_CAIP2).asset;
/** Never on the Allowlist: the "attacker" an injected prompt asks the Agent to pay. */
const ATTACKER = "attacker-not-allowed.testnet";

type Key = `ed25519:${string}`;

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

function credential(accountId: string): Key {
  const file = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  return (JSON.parse(readFileSync(file, "utf8")) as { private_key: Key }).private_key;
}

function check(condition: boolean, message: string): string {
  if (!condition) throw new Error(`proof check failed: ${message}`);
  console.log(`  ✓ ${message}`);
  return message;
}

export async function runProof(): Promise<Proof> {
  loadDotenv({ path: join(REPO, ".env"), quiet: true });
  const allowanceId = env("ALLOWANCE_ACCOUNT_ID");
  const ownerId = env("OWNER_ACCOUNT_ID");
  const relayerId = env("RELAYER_ACCOUNT_ID");
  const payeeId = env("PAYEE_ACCOUNT_ID");
  const provider = new JsonRpcProvider({ url: RPC });
  const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
    (await provider.callFunction({ contractId, method, args })) as T;
  const usdc = async (id: string) => BigInt(await view<string>(USDC, "ft_balance_of", { account_id: id }));

  // The Agent: the Allowance account signed with its request_spend-only key. Every
  // request_spend transaction hash is recorded for the proof.
  const agent = new Account(allowanceId, provider, readAgentKeyFile(env("AGENT_KEY_FILE")));
  const spendTxs = new Map<string, string>();
  const callFunctionRaw = agent.callFunctionRaw.bind(agent);
  agent.callFunctionRaw = (async (params: Parameters<typeof callFunctionRaw>[0]) => {
    const outcome = await callFunctionRaw(params);
    const id = (params.args as { request_id?: string }).request_id;
    if (id) spendTxs.set(id, outcome.transaction_outcome.id);
    return outcome;
  }) as typeof agent.callFunctionRaw;
  const owner = new Account(ownerId, provider, credential(ownerId));

  // The official facilitator, unmodified, with our relayer paying settlement gas.
  const facilitatorSigner = createFacilitatorNearSigner({
    relayers: [{ accountId: relayerId, secretKey: credential(relayerId) }],
    rpcUrls: { [NEAR_TESTNET_CAIP2]: RPC },
  });
  const official = new x402Facilitator().register(NEAR_TESTNET_CAIP2, new ExactNearScheme(facilitatorSigner));
  const facilitator = {
    verify: official.verify.bind(official),
    settle: official.settle.bind(official),
    getSupported: () => Promise.resolve(official.getSupported() as SupportedResponse),
  };
  const seller = await startSeller({ facilitator, payTo: payeeId, prices: { weather: "$0.10", report: "$1.00" } });
  const attackerSeller = await startSeller({ facilitator, payTo: ATTACKER, prices: { weather: "$0.10" } });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createAllowanceServer(new AllowanceClient(nearAllowance(agent, allowanceId), { network: NEAR_TESTNET_CAIP2 })).connect(serverSide);
  const mcp = new Client({ name: "proof-agent", version: "1.0.0" });
  await mcp.connect(clientSide);
  // biome-ignore lint: tool results are JSON
  const call = async (name: string, args: Record<string, unknown>): Promise<any> =>
    (await mcp.callTool({ name, arguments: args })).structuredContent;

  const steps: ProofStep[] = [];
  const spendTx = (id: string): ProofTx => ({ label: "Spend Request (request_spend, Agent key)", hash: spendTxs.get(id)! });
  try {
    const policy = await view<{ daily_cap: string; auto_limit: string; hard_ceiling: string; velocity_limit: number }>(allowanceId, "get_policy");
    const payer = await view<string>(allowanceId, "payer_account_id");

    console.log("1. Approved: $0.10 data call");
    let payeeBefore = await usdc(payeeId);
    const paid = await call("allowance_pay", { url: `${seller.url}/weather?city=Lisbon`, max_usd: "0.50" });
    const r1 = await view<{ outcome: string; status: string }>(allowanceId, "get_request", { request_id: paid.request_id });
    steps.push({
      title: "1. Approved: a $0.10 call is paid",
      request_id: paid.request_id,
      outcome: r1.outcome,
      status: r1.status,
      checks: [
        check(paid.result === "paid" && paid.http_status === 200, "the seller answered 200 after verifying and settling the Signed Payment"),
        check(paid.settlement?.success === true && paid.settlement?.payer === payer, "settled by the facilitator, payer = the Payer Account"),
        check((await usdc(payeeId)) - payeeBefore === 100_000n, "the Payee's USDC rose by exactly $0.10"),
      ],
      transactions: [spendTx(paid.request_id), { label: "x402 settlement (relayed by the facilitator)", hash: paid.settlement.transaction }],
    });

    console.log("2. Blocked: paying an account not on the Allowlist");
    const budgetBefore = await view<{ usdc_balance: string }>(allowanceId, "get_budget");
    const payerBefore = await usdc(payer);
    const blocked = await call("allowance_pay", { url: `${attackerSeller.url}/weather`, max_usd: "0.50" });
    const r2 = await view<{ outcome: string; status: string; blocked_reason: string; payment: unknown }>(allowanceId, "get_request", {
      request_id: blocked.request_id,
    });
    steps.push({
      title: "2. Blocked: an injected payment to an unknown Payee",
      request_id: blocked.request_id,
      outcome: r2.outcome,
      status: r2.status,
      blocked_reason: r2.blocked_reason,
      checks: [
        check(blocked.result === "blocked" && r2.blocked_reason === "UnknownPayee", `Blocked with reason UnknownPayee (${ATTACKER} is not on the Allowlist)`),
        check(r2.payment === null, "no Signed Payment was built, so nothing reached the signer"),
        check((await view<{ usdc_balance: string }>(allowanceId, "get_budget")).usdc_balance === budgetBefore.usdc_balance, "the Allowance's USDC is unchanged"),
        check((await usdc(payer)) === payerBefore, "nothing moved into the Payer Account"),
      ],
      transactions: [spendTx(blocked.request_id)],
    });

    console.log("3. Pending: a $1.00 report, approved by the Owner, then resumed");
    payeeBefore = await usdc(payeeId);
    const pending = await call("allowance_pay", { url: `${seller.url}/report`, max_usd: "2" });
    check(pending.result === "pending", "the $1.00 report is above the Auto Limit and waits for the Owner");
    const approve = await owner.callFunctionRaw({
      contractId: allowanceId,
      methodName: "approve",
      args: { request_id: pending.request_id },
      deposit: 1n,
      gas: 50_000_000_000_000n,
      waitUntil: "FINAL",
    });
    const resumed = await call("allowance_resume", { request_id: pending.request_id, url: `${seller.url}/report` });
    const r3 = await view<{ outcome: string; status: string }>(allowanceId, "get_request", { request_id: pending.request_id });
    steps.push({
      title: "3. Pending, approved by the Owner, picked up by the Agent and paid",
      request_id: pending.request_id,
      outcome: r3.outcome,
      status: r3.status,
      checks: [
        "the $1.00 report is above the Auto Limit and waited for the Owner",
        check(resumed.result === "paid" && resumed.http_status === 200, "after the Owner's approval, allowance_resume picked up the Signed Payment and the seller answered 200"),
        check((await usdc(payeeId)) - payeeBefore === 1_000_000n, "the Payee's USDC rose by exactly $1.00"),
      ],
      transactions: [
        { label: "Spend Request (Pending)", hash: spendTx(pending.request_id).hash },
        { label: "Owner approval (Owner key, 1 yoctoNEAR attached)", hash: approve.transaction_outcome.id },
        { label: "x402 settlement (relayed by the facilitator)", hash: resumed.settlement.transaction },
      ],
    });

    const usd = (v: string) => (Number(v) / 1e6).toFixed(2);
    const proof: Proof = {
      network: "testnet",
      ran_at: new Date().toISOString(),
      allowance: allowanceId,
      payer_account: payer,
      owner: ownerId,
      payee: payeeId,
      facilitator_relayer: relayerId,
      signer: SIGNER,
      usdc: USDC,
      policy: {
        daily_cap_usd: usd(policy.daily_cap),
        auto_limit_usd: usd(policy.auto_limit),
        hard_ceiling_usd: usd(policy.hard_ceiling),
        velocity_limit: policy.velocity_limit,
      },
      deploy: JSON.parse(readFileSync(join(REPO, "docs/proof/deploy.json"), "utf8")) as ProofTx[],
      steps,
    };
    const problems = validateProof(proof);
    if (problems.length) throw new Error(`proof incomplete: ${problems.join("; ")}`);
    return proof;
  } finally {
    await mcp.close();
    await Promise.all([seller.close(), attackerSeller.close()]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.PROOF_TESTNET !== "1") {
    console.log("skipped: set PROOF_TESTNET=1 to run the testnet proof (spends real testnet USDC)");
  } else {
    const proof = await runProof();
    writeFileSync(PROOF_JSON, JSON.stringify(proof, null, 2) + "\n");
    writeFileSync(PROOF_MD, renderProof(proof));
    console.log(`wrote ${PROOF_JSON} and ${PROOF_MD}`);
  }
}
