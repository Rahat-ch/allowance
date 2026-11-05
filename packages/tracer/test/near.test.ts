import { describe, expect, it } from "vitest";
import { isFastRpc } from "../src/near.js";

describe("isFastRpc", () => {
  it.each([
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.fastnear.com/",
    "https://fastnear.com",
  ])("accepts FastNEAR %s", url => {
    expect(isFastRpc(url)).toBe(true);
  });

  it.each([
    "https://rpc.testnet.near.org",
    "https://evilfastnear.com",
    "https://fastnear.com.example.org",
    "not a url",
    "",
  ])("rejects %j", url => {
    expect(isFastRpc(url)).toBe(false);
  });
});
