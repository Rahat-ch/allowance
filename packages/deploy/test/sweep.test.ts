import { describe, expect, it } from "vitest";
import { parseSweepArgs } from "../src/sweep.js";

describe("parseSweepArgs", () => {
  it("sweeps everything without an amount", () => {
    expect(parseSweepArgs([])).toEqual({ help: false });
    expect(parseSweepArgs(["--"])).toEqual({ help: false });
  });

  it("reads a USDC amount after pnpm's --", () => {
    expect(parseSweepArgs(["--", "1.5"])).toEqual({ amount: 1_500_000n, help: false });
  });

  it("refuses zero, bad amounts and extra arguments", () => {
    expect(() => parseSweepArgs(["0"])).toThrow(/positive/);
    expect(() => parseSweepArgs(["1.1234567"])).toThrow(/at most 6 decimals/);
    expect(() => parseSweepArgs(["1", "2"])).toThrow(/usage/);
    expect(() => parseSweepArgs(["--force"])).toThrow(/usage/);
  });
});
