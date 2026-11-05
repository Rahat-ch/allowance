import { describe, expect, it } from "vitest";
import { formatUsdc, parseUsdc } from "../src/usdc.js";

describe("parseUsdc", () => {
  it.each([
    ["1", 1_000_000n],
    ["0.01", 10_000n],
    ["1.5", 1_500_000n],
    ["20.000001", 20_000_001n],
    [" 2 ", 2_000_000n],
  ])("parses %s", (input, atomic) => {
    expect(parseUsdc(input)).toBe(atomic);
  });

  it.each(["", "0", "0.0", "1.0000001", "-1", "1e3", "abc", ".5"])("rejects %j", input => {
    expect(() => parseUsdc(input)).toThrow();
  });
});

describe("formatUsdc", () => {
  it.each([
    [0n, "0.000000"],
    [10_000n, "0.010000"],
    [20_000_001n, "20.000001"],
    [-10_000n, "-0.010000"],
  ])("formats %s", (atomic, text) => {
    expect(formatUsdc(atomic)).toBe(text);
  });
});
