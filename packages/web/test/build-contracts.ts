import { buildContracts } from "sandbox/contracts";

/** One cargo build before the sandbox tests. */
export default function setup(): void {
  buildContracts();
}
