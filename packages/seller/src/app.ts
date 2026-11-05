/**
 * The demo seller: a pay-per-call API protected by the official x402 Express
 * middleware and NEAR `exact` resource server scheme. There is no custom 402
 * code here; the middleware builds every PAYMENT-REQUIRED and PAYMENT-RESPONSE,
 * and a standard facilitator verifies and settles.
 *
 * Prices are dollars, paid in USDC (6 decimals) to the Payee (`payTo`).
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2, getDefaultAsset } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/server";

export type NearNetwork = typeof NEAR_TESTNET_CAIP2 | typeof NEAR_MAINNET_CAIP2;
export const NEAR_NETWORKS: readonly NearNetwork[] = [NEAR_TESTNET_CAIP2, NEAR_MAINNET_CAIP2];

/** A price in dollars, e.g. `"$0.50"`. */
export type Dollars = `$${string}`;

export type Prices = {
  /** `GET /weather`, the cheap data call. */
  weather: Dollars;
  /** `GET /report`, the premium report. */
  report: Dollars;
};

export const DEFAULT_PRICES: Prices = { weather: "$0.50", report: "$15.00" };
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

export type SellerOptions = {
  /** Verifies and settles payments: an `HTTPFacilitatorClient`, or one in process. */
  facilitator: FacilitatorClient;
  /** Defaults to `near:testnet`. */
  network?: NearNetwork;
  /** The Payee: the NEAR account paid for every call. */
  payTo: string;
  /** USDC (NEP-141) contract the prices are paid in; defaults to the network's Circle USDC. */
  asset?: string;
  prices?: Partial<Prices>;
  /** How long a Signed Payment for this seller may stay valid. */
  maxTimeoutSeconds?: number;
};

export type ResolvedSellerConfig = Required<Omit<SellerOptions, "facilitator" | "prices">> & { prices: Prices };

export function resolveConfig(options: SellerOptions): ResolvedSellerConfig {
  const network = options.network ?? NEAR_TESTNET_CAIP2;
  if (!NEAR_NETWORKS.includes(network)) throw new Error(`network must be one of ${NEAR_NETWORKS.join(", ")}, got ${network}`);
  if (!options.payTo) throw new Error("payTo (the Payee account) is required");
  const prices = { ...DEFAULT_PRICES, ...options.prices };
  for (const [route, price] of Object.entries(prices)) {
    if (!price.startsWith("$")) throw new Error(`${route} price must be dollars like "$0.50", got ${price}`);
    dollarsToBaseUnits(price.slice(1));
  }
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error(`maxTimeoutSeconds must be a positive integer, got ${maxTimeoutSeconds}`);
  }
  return {
    network,
    payTo: options.payTo,
    asset: options.asset ?? getDefaultAsset(network).asset,
    prices,
    maxTimeoutSeconds,
  };
}

/** The Express app, unstarted. Tests inject an in-process facilitator here. */
export function createApp(options: SellerOptions): Express {
  const config = resolveConfig(options);
  const scheme = new ExactNearScheme().registerMoneyParser(async (amount, network) =>
    network === config.network ? { amount: dollarsToBaseUnits(String(amount)), asset: config.asset, extra: {} } : null,
  );
  const resourceServer = new x402ResourceServer(options.facilitator).register(config.network, scheme);

  const offer = (price: Dollars) => ({
    scheme: "exact" as const,
    price,
    network: config.network,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  });

  const app = express();
  app.get("/", (_req, res) => {
    res.json({
      name: "Allowance demo seller",
      network: config.network,
      payTo: config.payTo,
      asset: config.asset,
      routes: { "GET /weather": config.prices.weather, "GET /report": config.prices.report },
    });
  });
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: [offer(config.prices.weather)],
          description: "Current weather for a city (demo data call)",
          mimeType: "application/json",
        },
        "GET /report": {
          accepts: [offer(config.prices.report)],
          description: "Premium market report (demo)",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );
  app.get("/weather", (req, res) => {
    const city = typeof req.query.city === "string" && req.query.city ? req.query.city : "Lisbon";
    res.json({ city, temperatureC: 21, conditions: "Sunny", source: "Allowance demo seller" });
  });
  app.get("/report", (_req, res) => {
    res.json({
      title: "Premium report: stablecoin payments on NEAR",
      summary: "Agent-initiated USDC payments settle in about a second with gas paid by the facilitator.",
      sections: [
        { heading: "Volume", body: "Demo data: x402 calls grew week over week." },
        { heading: "Outlook", body: "Demo data: budgets enforced on-chain keep agent spending bounded." },
      ],
      source: "Allowance demo seller",
    });
  });
  return app;
}

export type Seller = { url: string; server: Server; close(): Promise<void> };

/** Starts the seller; `port` 0 (the default) picks a free port. */
export async function startSeller(options: SellerOptions & { port?: number; host?: string }): Promise<Seller> {
  const app = createApp(options);
  const host = options.host ?? "127.0.0.1";
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(options.port ?? 0, host, (error?: Error) => (error ? reject(error) : resolve(s)));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    server,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** "0.5" → "500000": decimal dollars to 6-decimal USDC base units, without float rounding. */
export function dollarsToBaseUnits(dollars: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(dollars);
  if (!match) throw new Error(`price must be dollars with at most 6 decimals, got ${dollars}`);
  return (BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))).toString();
}
