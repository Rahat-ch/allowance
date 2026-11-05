import { describe, expect, it } from "vitest";
import { retry } from "../src/retry.js";

function flaky<T>(failures: number, value: T): () => Promise<T> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls <= failures) throw new Error(`transient ${calls}`);
    return value;
  };
}

describe("retry", () => {
  it("returns the first success, backing off exponentially between failures", async () => {
    const slept: number[] = [];
    const result = await retry(flaky(3, "ok"), {
      attempts: 5,
      baseDelayMs: 100,
      sleep: async ms => void slept.push(ms),
    });
    expect(result).toBe("ok");
    expect(slept).toEqual([100, 200, 400]);
  });

  it("caps the delay", async () => {
    const slept: number[] = [];
    await retry(flaky(4, 1), {
      attempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250,
      sleep: async ms => void slept.push(ms),
    });
    expect(slept).toEqual([100, 200, 250, 250]);
  });

  it("rethrows the last error once attempts run out", async () => {
    const slept: number[] = [];
    await expect(
      retry(flaky(10, 1), { attempts: 3, baseDelayMs: 1, sleep: async ms => void slept.push(ms) }),
    ).rejects.toThrow("transient 3");
    expect(slept).toHaveLength(2);
  });

  it("reports each retry", async () => {
    const seen: [string, number][] = [];
    await retry(flaky(2, 1), {
      attempts: 3,
      baseDelayMs: 10,
      sleep: async () => {},
      onRetry: (error, attempt) => void seen.push([String((error as Error).message), attempt]),
    });
    expect(seen).toEqual([
      ["transient 1", 1],
      ["transient 2", 2],
    ]);
  });

  it("rejects fewer than one attempt", async () => {
    await expect(retry(async () => 1, { attempts: 0, baseDelayMs: 1 })).rejects.toThrow(/attempts/);
  });
});
