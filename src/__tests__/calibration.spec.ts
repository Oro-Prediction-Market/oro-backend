import { CalibrationService } from "../users/calibration.service";
import { PositionStatus } from "../entities/position.entity";
import { FreeCallStatus } from "../entities/free-call.entity";
import { NotFoundException } from "@nestjs/common";

describe("CalibrationService", () => {
  function build(opts: {
    user?: any;
    positions?: any[];
    freeCalls?: any[];
  } = {}) {
    const user =
      opts.user === undefined
        ? {
            id: "u1",
            reputationTier: "sharpshooter",
            brierScore: 0.18,
            brierCount: 12,
            totalPredictions: 12,
            correctPredictions: 8,
            freeCallBrierScore: 0.22,
            freeCallCount: 6,
            freeCallCorrect: 4,
            categoryScores: {
              sports: { correct: 8, total: 10 },
              weather: { correct: 1, total: 5 },
              gaming: { correct: 1, total: 1 },
            },
          }
        : opts.user;

    const userRepo: any = { findOne: jest.fn(async () => user) };
    const positionRepo: any = {
      find: jest.fn(async () => opts.positions ?? []),
    };
    const freeCallRepo: any = {
      find: jest.fn(async () => opts.freeCalls ?? []),
    };
    return {
      svc: new CalibrationService(userRepo, positionRepo, freeCallRepo),
    };
  }

  const pos = (p: number | null, won: boolean, marketId = Math.random().toString()) => ({
    marketId,
    status: won ? PositionStatus.WON : PositionStatus.LOST,
    predictedProbability: p,
    placedAt: new Date(),
  });

  const call = (p: number, correct: boolean) => ({
    status: correct ? FreeCallStatus.CORRECT : FreeCallStatus.INCORRECT,
    probabilityAtCall: p,
  });

  it("reports staked and free records separately", async () => {
    const { svc } = build();

    const profile = await svc.getProfile("u1");

    expect(profile.staked.brierScore).toBe(0.18);
    expect(profile.staked.scored).toBe(12);
    expect(profile.free.brierScore).toBe(0.22);
    expect(profile.free.scored).toBe(6);
    expect(profile.tier).toBe("sharpshooter");
  });

  it("buckets the calibration curve and drops empty buckets", async () => {
    const { svc } = build({
      positions: [
        pos(0.75, true, "m1"),
        pos(0.72, true, "m2"),
        pos(0.78, false, "m3"),
        pos(0.15, false, "m4"),
      ],
    });

    const profile = await svc.getProfile("u1");
    const buckets = profile.staked.curve;

    expect(buckets.map((b) => b.bucket)).toEqual([10, 70]);
    const seventies = buckets.find((b) => b.bucket === 70)!;
    expect(seventies.count).toBe(3);
    // Two of three calls at ~75% landed.
    expect(seventies.actual).toBeCloseTo(2 / 3, 3);
    expect(seventies.predicted).toBeCloseTo(0.75, 2);
  });

  it("puts a probability of exactly 1.0 in the top bucket, not an eleventh", async () => {
    const { svc } = build({ positions: [pos(1, true, "m1")] });

    const profile = await svc.getProfile("u1");

    expect(profile.staked.curve).toHaveLength(1);
    expect(profile.staked.curve[0].bucket).toBe(90);
  });

  it("counts one market once, however many bets were placed on it", async () => {
    const { svc } = build({
      positions: [pos(0.6, true, "m1"), pos(0.6, true, "m1"), pos(0.6, true, "m1")],
    });

    const profile = await svc.getProfile("u1");

    expect(profile.staked.curve[0].count).toBe(1);
  });

  it("ignores positions with no recorded probability", async () => {
    const { svc } = build({
      positions: [pos(null, true, "m1"), pos(0.5, true, "m2")],
    });

    const profile = await svc.getProfile("u1");

    expect(
      profile.staked.curve.reduce((a, b) => a + b.count, 0),
    ).toBe(1);
  });

  it("calls out overconfidence when the calls do not back it up", async () => {
    const { svc } = build({
      positions: Array.from({ length: 12 }, (_, i) =>
        pos(0.9, i < 3, `m${i}`),
      ),
    });

    const profile = await svc.getProfile("u1");

    // Assigned 0.9 on average, hit 25% — a large positive gap.
    expect(profile.confidenceGap).toBeCloseTo(0.65, 2);
    expect(profile.verdict).toMatch(/back your calls harder/);
  });

  it("calls out underconfidence too", async () => {
    const { svc } = build({
      positions: Array.from({ length: 12 }, (_, i) =>
        pos(0.3, i < 10, `m${i}`),
      ),
    });

    const profile = await svc.getProfile("u1");

    expect(profile.confidenceGap).toBeLessThan(-0.1);
    expect(profile.verdict).toMatch(/better than your confidence/);
  });

  it("says well calibrated when assigned probability tracks reality", async () => {
    const { svc } = build({
      positions: Array.from({ length: 10 }, (_, i) => pos(0.7, i < 7, `m${i}`)),
    });

    const profile = await svc.getProfile("u1");

    expect(profile.verdict).toMatch(/Well calibrated/);
  });

  it("refuses to draw a conclusion from too few calls", async () => {
    const { svc } = build({ positions: [pos(0.9, false, "m1")] });

    const profile = await svc.getProfile("u1");

    expect(profile.verdict).toMatch(/1 scored call so far/);
  });

  it("says so plainly when there is no record yet", async () => {
    const { svc } = build({
      user: {
        id: "u1",
        reputationTier: null,
        brierScore: null,
        brierCount: 0,
        totalPredictions: 0,
        correctPredictions: 0,
        freeCallBrierScore: null,
        freeCallCount: 0,
        freeCallCorrect: 0,
        categoryScores: null,
      },
    });

    const profile = await svc.getProfile("u1");

    expect(profile.confidenceGap).toBeNull();
    expect(profile.verdict).toMatch(/No scored calls yet/);
    expect(profile.strongestCategory).toBeNull();
  });

  it("blends staked and free calls for the confidence gap only", async () => {
    const { svc } = build({
      positions: Array.from({ length: 6 }, (_, i) => pos(0.5, i < 3, `m${i}`)),
      freeCalls: Array.from({ length: 6 }, (_, i) => call(0.5, i < 3)),
    });

    const profile = await svc.getProfile("u1");

    // 12 observations, mean p 0.5, hit rate 0.5.
    expect(profile.confidenceGap).toBeCloseTo(0, 5);
    // But the two records stay separate.
    expect(profile.staked.curve[0].count).toBe(6);
    expect(profile.free.curve[0].count).toBe(6);
  });

  it("names the strongest and weakest category, ignoring thin samples", async () => {
    const { svc } = build();

    const profile = await svc.getProfile("u1");

    expect(profile.strongestCategory?.category).toBe("sports");
    expect(profile.weakestCategory?.category).toBe("weather");
    // gaming has 1 observation and must not qualify as either.
    expect(profile.strongestCategory?.category).not.toBe("gaming");
    expect(profile.weakestCategory?.category).not.toBe("gaming");
  });

  it("404s on an unknown user", async () => {
    const { svc } = build({ user: null });

    await expect(svc.getProfile("nope")).rejects.toThrow(NotFoundException);
  });
});
