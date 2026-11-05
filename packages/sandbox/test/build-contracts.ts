import { buildContracts } from "../src/contracts.js";

/** One cargo build for every sandbox test file. */
export default function setup(): void {
  buildContracts();
}
