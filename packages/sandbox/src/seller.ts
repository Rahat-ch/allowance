/**
 * A minimal x402 seller for the harness: the official Express middleware and
 * resource server, no custom 402 code. Prices are dollars, paid in the
 * configured USDC token (the mock in sandbox).
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactNearScheme } from "@x402/near/exact/server";
import type { Facilitator } from "./facilitator.js";
import { NETWORK } from "./harness.js";

export type SellerOptions = {
  facilitator: Facilitator;
  payTo: string;
  /** NEP-141 token the prices are paid in (6 decimals). */
  asset: string;
  /** Route to price in dollars, e.g. `{ "GET /data": "$0.50" }`. */
  routes: Record<string, `$${string}`>;
  maxTimeoutSeconds?: number;
};

export type Seller = { url: string; close(): Promise<void> };

export async function startSeller(options: SellerOptions): Promise<Seller> {
  const scheme = new ExactNearScheme().registerMoneyParser(async (amount) => ({
    amount: dollarsToBaseUnits(String(amount)),
    asset: options.asset,
    extra: {},
  }));
  const resourceServer = new x402ResourceServer(options.facilitator).register(NETWORK, scheme);
  const routes: Parameters<typeof paymentMiddleware>[0] = Object.fromEntries(
    Object.entries(options.routes).map(([route, price]) => [
      route,
      {
        accepts: [
          {
            scheme: "exact" as const,
            price,
            network: NETWORK,
            payTo: options.payTo,
            maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
          },
        ],
        description: `Harness resource ${route}`,
      },
    ]),
  );

  const app = express();
  app.use(paymentMiddleware(routes, resourceServer));
  for (const route of Object.keys(options.routes)) {
    const [method, path] = route.split(" ") as [string, string];
    app[method.toLowerCase() as "get" | "post"](path, (_req, res) => {
      res.json({ ok: true, route });
    });
  }

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** "0.5" → "500000": decimal dollars to 6-decimal base units, without float rounding. */
export function dollarsToBaseUnits(dollars: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(dollars);
  if (!match) throw new Error(`price must be dollars with at most 6 decimals, got ${dollars}`);
  return (BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))).toString();
}
