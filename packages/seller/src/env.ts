/**
 * Seller configuration from environment variables:
 *
 *   SELLER_PAY_TO              Payee account (required)
 *   FACILITATOR_URL            x402 facilitator base URL (required)
 *   SELLER_NETWORK             near:testnet (default) or near:mainnet
 *   SELLER_ASSET               USDC contract; defaults to the network's Circle USDC
 *   SELLER_WEATHER_PRICE       default $0.50
 *   SELLER_REPORT_PRICE        default $15.00
 *   SELLER_MAX_TIMEOUT_SECONDS default 60
 *   PORT                       default 4021
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { NEAR_NETWORKS, type Dollars, type NearNetwork, type Prices, type SellerOptions } from "./app.js";

export const DEFAULT_PORT = 4021;

export type SellerEnv = SellerOptions & { facilitatorUrl: string; port: number };

export function sellerOptionsFromEnv(env: Record<string, string | undefined> = process.env): SellerEnv {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;

  const network = optional("SELLER_NETWORK");
  if (network !== undefined && !NEAR_NETWORKS.includes(network as NearNetwork)) {
    throw new Error(`SELLER_NETWORK must be one of ${NEAR_NETWORKS.join(", ")}, got ${network}`);
  }
  const prices: Partial<Prices> = {};
  const weather = optional("SELLER_WEATHER_PRICE");
  const report = optional("SELLER_REPORT_PRICE");
  if (weather) prices.weather = asDollars(weather);
  if (report) prices.report = asDollars(report);
  const timeout = optional("SELLER_MAX_TIMEOUT_SECONDS");
  const port = optional("PORT");

  const facilitatorUrl = required("FACILITATOR_URL");
  return {
    facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }),
    facilitatorUrl,
    payTo: required("SELLER_PAY_TO"),
    ...(network ? { network: network as NearNetwork } : {}),
    ...(optional("SELLER_ASSET") ? { asset: optional("SELLER_ASSET")! } : {}),
    prices,
    ...(timeout ? { maxTimeoutSeconds: Number(timeout) } : {}),
    port: port ? Number(port) : DEFAULT_PORT,
  };
}

/** "0.50" or "$0.50" → "$0.50". */
function asDollars(price: string): Dollars {
  return (price.startsWith("$") ? price : `$${price}`) as Dollars;
}
