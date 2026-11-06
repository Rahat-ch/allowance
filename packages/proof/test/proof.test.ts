/**
 * The proof document matches the recorded testnet run, and the run records every
 * required case with real transaction hashes.
 */
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { renderProof, validateProof, type Proof } from "../src/record.js";
import { PROOF_JSON, PROOF_MD } from "../src/run.js";

const recorded = existsSync(PROOF_JSON) ? (JSON.parse(readFileSync(PROOF_JSON, "utf8")) as Proof) : null;

test.skipIf(!recorded)("docs/proof/testnet.md is exactly what the recorded run renders", () => {
  expect(readFileSync(PROOF_MD, "utf8")).toBe(renderProof(recorded!));
});

test.skipIf(!recorded)("the recorded run covers Approved, Blocked and Pending-then-approved with real hashes", () => {
  expect(validateProof(recorded!)).toEqual([]);
  const blocked = recorded!.steps.find((s) => s.outcome === "Blocked")!;
  expect(blocked.blocked_reason).toBe("UnknownPayee");
  expect(blocked.transactions).toHaveLength(1); // a Spend Request, and no settlement
});

test("an incomplete proof is caught", () => {
  const proof = {
    deploy: [{ label: "x", hash: "not-a-hash" }],
    steps: [{ outcome: "Approved", status: "Signed", transactions: [] }],
  } as unknown as Proof;
  expect(validateProof(proof)).toEqual([
    "not a transaction hash: x not-a-hash",
    "no Blocked/Blocked step",
    "no Pending/Signed step",
  ]);
});
