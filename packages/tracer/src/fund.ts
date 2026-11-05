/**
 * `pnpm --filter tracer fund <USDC>`: the Owner sends USDC to the Allowance
 * with a plain `ft_transfer` (the Allowance must be storage-registered; deploy
 * does that).
 */
import { USDC_TESTNET, isMain, loadEnv, requireEnv, txLink } from "./config.js";
import { ONE_YOCTO, TGAS, accountFromCredentials, isUsdcRegistered, usdcBalance } from "./near.js";
import { formatUsdc, parseUsdc } from "./usdc.js";

async function main(): Promise<void> {
  loadEnv();
  const arg = process.argv.slice(2).find(a => a !== "--");
  if (!arg) throw new Error("usage: pnpm --filter tracer fund <USDC amount, e.g. 1.5>");
  const amount = parseUsdc(arg);
  const ownerId = requireEnv("OWNER_ACCOUNT_ID");
  const allowanceId = requireEnv("ALLOWANCE_ACCOUNT_ID");

  if (!(await isUsdcRegistered(allowanceId))) {
    throw new Error(`${allowanceId} is not registered for USDC storage; run deploy first`);
  }
  const ownerBalance = await usdcBalance(ownerId);
  if (ownerBalance < amount) {
    throw new Error(`Owner ${ownerId} has ${formatUsdc(ownerBalance)} USDC, needs ${formatUsdc(amount)}`);
  }
  const before = await usdcBalance(allowanceId);

  const outcome = await (await accountFromCredentials(ownerId)).callFunctionRaw({
    contractId: USDC_TESTNET,
    methodName: "ft_transfer",
    args: { receiver_id: allowanceId, amount: amount.toString(), memo: "Allowance funding" },
    deposit: ONE_YOCTO,
    gas: 30n * TGAS,
  });
  const after = await usdcBalance(allowanceId);
  console.log(`ft_transfer ${formatUsdc(amount)} USDC ${ownerId} -> ${allowanceId}`);
  console.log(`  ${txLink(outcome.transaction_outcome.id)}`);
  console.log(`  Allowance USDC: ${formatUsdc(before)} -> ${formatUsdc(after)}`);
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
