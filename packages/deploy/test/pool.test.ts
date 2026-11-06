import { describe, expect, it } from "vitest";
import { LEASE_OVERHEAD_BLOCKS, poolSizing } from "../src/pool.js";

describe("poolSizing", () => {
  it("needs strictly more keys than payments outstanding at the Velocity Limit", () => {
    // 60/hour x 600 blocks (~10 minutes) of validity: ~10.2 outstanding, so 11 keys.
    const sizing = poolSizing({ velocityLimit: 60, maxTimeoutBlocks: 600, keyCount: 11 });
    expect(sizing.leaseBlocks).toBe(600 + LEASE_OVERHEAD_BLOCKS);
    expect(sizing.concurrentAtVelocity).toBeCloseTo((60 * 610) / 3600);
    expect(sizing.requiredKeys).toBe(11);
    expect(sizing.verdict).toBe("warn"); // 11 < a burst of 32
  });

  it("refuses a pool that is too small", () => {
    const sizing = poolSizing({ velocityLimit: 60, maxTimeoutBlocks: 600, keyCount: 10 });
    expect(sizing.verdict).toBe("refuse");
    expect(sizing.message).toMatch(/needs at least 11 keys/);
  });

  it("counts an exact multiple as needing one more key", () => {
    // 36/hour x 100 blocks (with overhead) = exactly 1 outstanding: 1 key does not exceed it.
    const sizing = poolSizing({ velocityLimit: 36, maxTimeoutBlocks: 100 - LEASE_OVERHEAD_BLOCKS, keyCount: 1 });
    expect(sizing.concurrentAtVelocity).toBe(1);
    expect(sizing.requiredKeys).toBe(2);
    expect(sizing.verdict).toBe("refuse");
  });

  it("refuses a Policy no pool can serve", () => {
    const sizing = poolSizing({ velocityLimit: 1000, maxTimeoutBlocks: 600, keyCount: 32 });
    expect(sizing.verdict).toBe("refuse");
    expect(sizing.message).toMatch(/more than 32 keys/);
  });

  it.each([0, 33, 2.5])("refuses keyCount %s", (keyCount) => {
    expect(poolSizing({ velocityLimit: 1, maxTimeoutBlocks: 60, keyCount }).verdict).toBe("refuse");
  });

  it("warns when a burst could exhaust the pool", () => {
    const sizing = poolSizing({ velocityLimit: 10, maxTimeoutBlocks: 60, keyCount: 4 });
    expect(sizing.requiredKeys).toBe(1);
    expect(sizing.verdict).toBe("warn");
    expect(sizing.message).toMatch(/burst of up to 10/);
  });

  it("is ok when the pool covers a full burst", () => {
    expect(poolSizing({ velocityLimit: 4, maxTimeoutBlocks: 60, keyCount: 4 }).verdict).toBe("ok");
  });
});
