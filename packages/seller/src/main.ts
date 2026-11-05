/**
 * Runs the demo seller against an HTTP facilitator, configured from the
 * environment (see env.ts). `pnpm --filter seller start`.
 */
import { resolveConfig, startSeller } from "./app.js";
import { sellerOptionsFromEnv } from "./env.js";

const options = sellerOptionsFromEnv();
const config = resolveConfig(options);
const seller = await startSeller({ ...options, host: process.env.HOST ?? "0.0.0.0" });

console.log(`Allowance demo seller listening on ${seller.url}`);
console.log(`  network      ${config.network}`);
console.log(`  payTo        ${config.payTo}`);
console.log(`  asset        ${config.asset}`);
console.log(`  facilitator  ${options.facilitatorUrl}`);
console.log(`  GET /weather ${config.prices.weather}`);
console.log(`  GET /report  ${config.prices.report}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void seller.close().finally(() => process.exit(0));
  });
}
