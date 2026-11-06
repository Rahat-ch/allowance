/**
 * Runs the Allowance MCP server over stdio. Configuration: see config.ts or README.md.
 * Logs go to stderr; stdout carries the MCP protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Account, JsonRpcProvider } from "near-api-js";
import { AllowanceClient } from "./client.js";
import { configFromEnv } from "./config.js";
import { nearAllowance } from "./contract.js";
import { createAllowanceServer } from "./server.js";

const config = configFromEnv();
const provider = new JsonRpcProvider({ url: config.rpcUrl });
// The Allowance account, signed by the Agent's function-call key (request_spend only).
const agent = new Account(config.allowanceId, provider, config.agentKey);
const client = new AllowanceClient(nearAllowance(agent, config.allowanceId), {
  network: config.network,
  signTimeoutMs: config.signTimeoutMs,
});
const server = createAllowanceServer(client);
await server.connect(new StdioServerTransport());
console.error(`allowance MCP server: ${config.allowanceId} on ${config.network} via ${config.rpcUrl}`);
