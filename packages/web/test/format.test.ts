import { expect, test } from "vitest";
import { formatDuration, formatNear, formatUsdc, parseUsdc, timeAgo, timeUntil } from "../src/format.js";

test("USDC base units read as dollars with cents", () => {
  expect(formatUsdc(0n)).toBe("$0.00");
  expect(formatUsdc(15_000_000n)).toBe("$15.00");
  expect(formatUsdc(1_500_000n)).toBe("$1.50");
  expect(formatUsdc(10_000n)).toBe("$0.01");
  expect(formatUsdc(1_000_000_000_000n)).toBe("$1,000,000.00");
  expect(formatUsdc(-2_000_000n)).toBe("-$2.00");
});

test("sub-cent USDC amounts are shown, not rounded away", () => {
  expect(formatUsdc(1_234_567n)).toBe("$1.234567");
  expect(formatUsdc(1n)).toBe("$0.000001");
  expect(formatUsdc(1_005_000n)).toBe("$1.005");
});

test("dollars typed by a person parse to base units", () => {
  expect(parseUsdc("15")).toBe(15_000_000n);
  expect(parseUsdc("$1,000.50")).toBe(1_000_500_000n);
  expect(parseUsdc("0.000001")).toBe(1n);
  expect(parseUsdc("1.")).toBe(1_000_000n);
  expect(parseUsdc("1.0000001")).toBeNull();
  expect(parseUsdc("-1")).toBeNull();
  expect(parseUsdc("abc")).toBeNull();
  expect(parseUsdc("")).toBeNull();
});

test("yoctoNEAR reads as NEAR with up to 4 decimals, rounded down", () => {
  expect(formatNear(0n)).toBe("0 NEAR");
  expect(formatNear(10n ** 24n)).toBe("1 NEAR");
  expect(formatNear(25n * 10n ** 23n)).toBe("2.5 NEAR");
  expect(formatNear(1_234_567_000_000_000_000_000_000n)).toBe("1.2345 NEAR");
  expect(formatNear(1_000n * 10n ** 24n)).toBe("1,000 NEAR");
});

test("durations are coarse and never negative", () => {
  const s = 1000;
  expect(formatDuration(-5 * s)).toBe("0s");
  expect(formatDuration(45 * s)).toBe("45s");
  expect(formatDuration(12 * 60 * s)).toBe("12m");
  expect(formatDuration(3 * 3600 * s)).toBe("3h");
  expect(formatDuration((3 * 3600 + 5 * 60) * s)).toBe("3h 5m");
  expect(formatDuration(52 * 3600 * s)).toBe("2d 4h");
  expect(formatDuration(48 * 3600 * s)).toBe("2d");
});

test("time until and since chain timestamps (ns)", () => {
  const nowMs = 1_800_000_000_000;
  const ns = (ms: number) => ms * 1e6;
  expect(timeUntil(ns(nowMs + 90 * 60_000), nowMs)).toBe("in 1h 30m");
  expect(timeUntil(ns(nowMs - 1), nowMs)).toBe("now");
  expect(timeAgo(ns(nowMs - 5 * 60_000), nowMs)).toBe("5m ago");
  expect(timeAgo(ns(nowMs), nowMs)).toBe("just now");
});
