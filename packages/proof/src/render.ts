/** Re-renders docs/proof/testnet.md from the recorded docs/proof/testnet.json. */
import { readFileSync, writeFileSync } from "node:fs";
import { renderProof, type Proof } from "./record.js";
import { PROOF_JSON, PROOF_MD } from "./run.js";

writeFileSync(PROOF_MD, renderProof(JSON.parse(readFileSync(PROOF_JSON, "utf8")) as Proof));
console.log(`wrote ${PROOF_MD}`);
