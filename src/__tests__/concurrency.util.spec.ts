import { envLimit, mapWithConcurrency } from "../shared/utils/concurrency.util";

const tick = () => new Promise((r) => setImmediate(r));

describe("mapWithConcurrency", () => {
  it("keeps input order whatever order calls finish in", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("never has more than `limit` calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 50 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      },
    );
    expect(peak).toBe(4);
  });

  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles an empty list and a limit above the item count", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
    await expect(
      mapWithConcurrency([1, 2], 100, async (n) => n * 2),
    ).resolves.toEqual([2, 4]);
  });

  it("rejects with the first error and stops taking new items", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });
});

describe("envLimit", () => {
  it("accepts positive integers only", () => {
    expect(envLimit("8", 4)).toBe(8);
    expect(envLimit(undefined, 4)).toBe(4);
    expect(envLimit("0", 4)).toBe(4);
    expect(envLimit("-2", 4)).toBe(4);
    expect(envLimit("2.5", 4)).toBe(4);
    expect(envLimit("lots", 4)).toBe(4);
  });
});
