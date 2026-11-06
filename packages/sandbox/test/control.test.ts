/**
 * Seam 2 for ticket #9: Pause and Revoke on a real chain. Revoke deletes the Agent's
 * key, so the Agent can't even submit a Spend Request any more.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { newRequestId, requestSpend } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

const spend = () => requestSpend(h, { request_id: newRequestId(), payee: h.payee.accountId, amount: USDC, max_timeout_blocks: 60 });

test("Pause blocks the next request and unpause lets the Agent spend again", async () => {
  await h.owner.callFunction({ contractId: h.allowance.accountId, methodName: "pause", args: {} });
  expect(await spend()).toMatchObject({ outcome: "Blocked", blocked_reason: "Paused" });
  await h.ownerCall("unpause", {});
  expect((await spend()).outcome).toBe("Approved");
});

test("Revoke deletes the Agent's key on chain", async () => {
  const keyBefore = await h.view<string>(h.allowance.accountId, "get_agent_key");
  await h.ownerCall("revoke", {});
  const keys = await h.provider.viewAccessKeyList({ accountId: h.allowance.accountId });
  expect(keys.keys.map((k) => k.public_key)).not.toContain(keyBefore);
  await expect(spend()).rejects.toThrow();
  expect(await h.view(h.allowance.accountId, "is_revoked")).toBe(true);
});
