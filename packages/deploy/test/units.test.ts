import { describe, expect, it } from "vitest";
import { NEAR, formatNear, formatUsdc, parseNear, parseUsdc } from "../src/units.js";

describe("parseUsdc", () => {
  it.each([
    ["0", 0n],
    ["1", 1_000_000n],
    ["0.01", 10_000n],
    ["20.000001", 20_000_001n],
    [" 2 ", 2_000_000n],
  ])("parses %s", (input, atomic) => {
    expect(parseUsdc(input)).toBe(atomic);
  });

  it.each(["", "1.0000001", "-1", "1e3", "abc", ".5"])("rejects %j", (input) => {
    expect(() => parseUsdc(input)).toThrow();
  });
});

describe("formatUsdc", () => {
  it.each([
    [0n, "0.000000"],
    [20_000_001n, "20.000001"],
    [-10_000n, "-0.010000"],
  ])("formats %s", (atomic, text) => {
    expect(formatUsdc(atomic)).toBe(text);
  });
});

describe("NEAR amounts", () => {
  it("round-trips", () => {
    expect(parseNear("5")).toBe(5n * NEAR);
    expect(parseNear("0.00125")).toBe(1_250_000_000_000_000_000_000n);
    expect(formatNear(1_250_000_000_000_000_000_000n)).toBe("0.00125");
    expect(formatNear(5n * NEAR)).toBe("5");
  });

  it("rejects more than 24 decimals", () => {
    expect(() => parseNear("0.0000000000000000000000001")).toThrow();
  });
});
