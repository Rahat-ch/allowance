/**
 * Seam 2 + Seam 3: what happens to a Signed Payment when signing doesn't go
 * to plan. The mock signer only answers when the test tells it to.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { getRequest, newRequestId, requestSpend, waitForPayment } from "../src/agent.js";
import { USDC, startHarness, type Harness } from "../src/harness.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ autoRespond: false, allowanceUsdc: 10n * USDC });
});

afterAll(async () => {
  await h?.stop();
});

const seen = new Set<number>();

/** The next signature request this file hasn't seen yet. */
async function nextSignatureRequest() {
  for (let i = 0; i < 100; i++) {
    const fresh = (await h.pendingSignatures()).filter((p) => !seen.has(p.id));
    if (fresh.length > 1) throw new Error(`expected one new signature request, got ${fresh.length}`);
    if (fresh[0]) {
      seen.add(fresh[0].id);
      return fresh[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the Allowance never asked the signer");
}

test("the signer yields until it is told to respond, and the answer becomes the Signed Payment", async () => {
  const requestId = newRequestId();
  await requestSpend(h, { request_id: requestId, payee: h.payee.accountId, amount: USDC, max_timeout_blocks: 60 });

  const request = await nextSignatureRequest();
  expect(request).toMatchObject({ predecessor: h.allowance.accountId, path: "x402/0", domain_id: 1 });
  expect((await getRequest(h, requestId))?.status).toBe("Signing");

  expect(await h.respond(request.id, h.signatureFor(request))).toBe(true);
  const payment = await waitForPayment(h, requestId);
  expect(payment.status).toBe("Signed");
  expect(payment.payment?.signed_delegate_action).toBeTruthy();
});

test("a signer timeout leaves the payment counted as spent, and a late signature is still published", async () => {
  const allowanceBefore = await h.usdcBalance(h.allowance.accountId);
  const payerBefore = await h.usdcBalance(h.payerAccountId);
  const requestId = newRequestId();
  await requestSpend(h, { request_id: requestId, payee: h.payee.accountId, amount: 2n * USDC, max_timeout_blocks: 60 });
  const request = await nextSignatureRequest();

  await h.fastForward(250); // past the 200-block yield timeout
  const payment = await waitForPayment(h, requestId);

  expect(payment.status).toBe("SignatureUnavailable");
  expect(payment.payment?.signed_delegate_action).toBeNull();
  // The money already moved to the Payer Account and stays spent.
  expect(await h.usdcBalance(h.allowance.accountId)).toBe(allowanceBefore - 2n * USDC);
  expect(await h.usdcBalance(h.payerAccountId)).toBe(payerBefore + 2n * USDC);
  expect(await h.pendingSignatures()).toEqual([]);

  // The MPC nodes can still publish the signature after the timeout: anyone who
  // sees it could submit the payment, which is why it stays counted as spent.
  const late = h.signatureFor(request);
  expect(await h.respond(request.id, late)).toBe(false);
  expect(await h.view<number[] | null>(h.signer.accountId, "published_signature", { id: request.id })).toEqual(Array.from(late));
  expect((await getRequest(h, requestId))?.status).toBe("SignatureUnavailable");
});

test("a failed transfer into the Payer Account never reaches the signer and leaves the funds with the Allowance", async () => {
  const allowanceBefore = await h.usdcBalance(h.allowance.accountId);
  const requestId = newRequestId();
  await requestSpend(h, {
    request_id: requestId,
    payee: h.payee.accountId,
    amount: allowanceBefore + 1n, // more than the Allowance holds, so the transfer fails
    max_timeout_blocks: 60,
  });

  const payment = await waitForPayment(h, requestId);

  expect(payment.status).toBe("FundingFailed");
  expect(payment.payment).toBeNull();
  expect(await h.pendingSignatures()).toEqual([]);
  expect(await h.usdcBalance(h.allowance.accountId)).toBe(allowanceBefore);
});

test("a request the contract refuses fails at once with the contract's reason", async () => {
  const started = Date.now();
  await expect(
    requestSpend(h, { request_id: "short", payee: h.payee.accountId, amount: 1n, max_timeout_blocks: 60 }),
  ).rejects.toThrow("request_id must be 16-128 characters");
  expect(Date.now() - started).toBeLessThan(10_000);
});
