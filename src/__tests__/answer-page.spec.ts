import { AnswerService } from "../insights/answer.service";
import { MarketStatus } from "../entities/market.entity";
import { NotFoundException } from "@nestjs/common";

/**
 * The answer payload is what a shared Oro link resolves to. It has to read
 * correctly with no account, and it has to say what will decide the question —
 * a number nobody can check is not information.
 */
describe("AnswerService", () => {
  function build(opts: {
    market?: any;
    history?: any[];
    staked?: number;
    free?: number;
  } = {}) {
    const market =
      opts.market === undefined
        ? {
            id: "m1",
            title: "Will Bhutan qualify?",
            category: "sports",
            status: MarketStatus.OPEN,
            totalPool: 12000,
            resolutionCriteria: "Official AFC standings on 30 June.",
            evidenceUrl: null,
            evidenceNote: null,
            closesAt: new Date("2026-06-30T00:00:00Z"),
            resolvedAt: null,
            outcomes: [
              { id: "o1", label: "Yes", lmsrProbability: 0.73, sortOrder: 0, isWinner: false },
              { id: "o2", label: "No", lmsrProbability: 0.27, sortOrder: 1, isWinner: false },
            ],
          }
        : opts.market;

    const marketRepo: any = { findOne: jest.fn(async () => market) };
    const counter = (n: number) => ({
      createQueryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: () => qb,
          getRawOne: async () => ({ c: String(n) }),
        };
        return qb;
      },
    });
    const history: any = {
      getHistory: jest.fn(async () => opts.history ?? []),
    };

    return {
      svc: new AnswerService(
        marketRepo,
        counter(opts.staked ?? 9) as any,
        counter(opts.free ?? 4) as any,
        history,
      ),
    };
  }

  it("leads with the crowd's answer as a whole percent", async () => {
    const { svc } = build();

    const a = await svc.getAnswer("m1");

    expect(a.headline).toBe("Oro says 73% Yes");
    expect(a.outcomes[0]).toMatchObject({ label: "Yes", percent: 73 });
    expect(a.settled).toBe(false);
  });

  it("counts free callers as predictors alongside stakers", async () => {
    const { svc } = build({ staked: 9, free: 4 });

    const a = await svc.getAnswer("m1");

    expect(a.predictorCount).toBe(13);
    expect(a.summary).toContain("13 predictors");
  });

  it("carries the resolution criteria so the number can be checked", async () => {
    const { svc } = build();

    const a = await svc.getAnswer("m1");

    expect(a.resolutionCriteria).toBe("Official AFC standings on 30 June.");
  });

  it("switches to the result and the evidence once settled", async () => {
    const { svc } = build({
      market: {
        id: "m1",
        title: "Will Bhutan qualify?",
        category: "sports",
        status: MarketStatus.SETTLED,
        totalPool: 12000,
        resolutionCriteria: "Official AFC standings.",
        evidenceUrl: "https://example.org/standings",
        evidenceNote: "Bhutan finished 3rd.",
        closesAt: new Date("2026-06-30T00:00:00Z"),
        resolvedAt: new Date("2026-07-01T00:00:00Z"),
        outcomes: [
          { id: "o1", label: "Yes", lmsrProbability: 0.4, sortOrder: 0, isWinner: false },
          { id: "o2", label: "No", lmsrProbability: 0.6, sortOrder: 1, isWinner: true },
        ],
      },
    });

    const a = await svc.getAnswer("m1");

    expect(a.settled).toBe(true);
    expect(a.headline).toBe("Resolved: No");
    expect(a.evidenceUrl).toBe("https://example.org/standings");
    expect(a.evidenceNote).toBe("Bhutan finished 3rd.");
  });

  it("computes 24h movement for the outcome the headline is about", async () => {
    const now = Date.now();
    const { svc } = build({
      history: [
        {
          outcomeId: "o1",
          label: "Yes",
          points: [
            { capturedAt: new Date(now - 20 * 3600_000), probability: 0.6, totalPool: 1 },
            { capturedAt: new Date(now - 1 * 3600_000), probability: 0.73, totalPool: 1 },
          ],
        },
      ],
    });

    const a = await svc.getAnswer("m1");

    expect(a.change24h).toBeCloseTo(0.13, 5);
  });

  it("reports no movement rather than a number when there is one point", async () => {
    const { svc } = build({
      history: [
        {
          outcomeId: "o1",
          label: "Yes",
          points: [{ capturedAt: new Date(), probability: 0.73, totalPool: 1 }],
        },
      ],
    });

    const a = await svc.getAnswer("m1");

    expect(a.change24h).toBeNull();
  });

  it("says there is no answer yet rather than inventing one", async () => {
    const { svc } = build({
      market: {
        id: "m1",
        title: "Empty question",
        category: "other",
        status: MarketStatus.OPEN,
        totalPool: 0,
        resolutionCriteria: null,
        evidenceUrl: null,
        evidenceNote: null,
        closesAt: null,
        resolvedAt: null,
        outcomes: [],
      },
    });

    const a = await svc.getAnswer("m1");

    expect(a.headline).toBe("No answer yet");
    expect(a.hasAnswer).toBe(false);
    expect(a.outcomes).toEqual([]);
  });

  it("refuses to report 0% on an unfunded market", async () => {
    // Regression guard: auto-created TER/BTC markets sit at 0 for every outcome
    // until the first stake, and this used to render as "Oro says 0% UP" — a
    // crowd view that does not exist, indistinguishable from a real 0% call.
    const { svc } = build({
      market: {
        id: "m1",
        title: "TER — UP or DOWN in 3 hours?",
        category: "economy",
        status: MarketStatus.OPEN,
        totalPool: 0,
        resolutionCriteria: null,
        evidenceUrl: null,
        evidenceNote: null,
        closesAt: null,
        resolvedAt: null,
        outcomes: [
          { id: "o1", label: "UP", lmsrProbability: 0, sortOrder: 0, isWinner: false },
          { id: "o2", label: "DOWN", lmsrProbability: 0, sortOrder: 1, isWinner: false },
        ],
      },
      staked: 0,
      free: 0,
    });

    const a = await svc.getAnswer("m1");

    expect(a.hasAnswer).toBe(false);
    expect(a.headline).toBe("No answer yet");
    expect(a.headline).not.toContain("0%");
    expect(a.summary).toContain("nobody has taken a side yet");
    expect(a.change24h).toBeNull();
    // The outcomes still come back so the client can list them.
    expect(a.outcomes.map((o) => o.label)).toEqual(["UP", "DOWN"]);
  });

  it("still answers a settled market whose probabilities never moved off zero", async () => {
    const { svc } = build({
      market: {
        id: "m1",
        title: "TER — UP or DOWN in 3 hours?",
        category: "economy",
        status: MarketStatus.SETTLED,
        totalPool: 0,
        resolutionCriteria: "TER buy price at close.",
        evidenceUrl: null,
        evidenceNote: "TER buy price at close: Nu 135.07",
        closesAt: null,
        resolvedAt: new Date("2026-09-08T07:53:52Z"),
        outcomes: [
          { id: "o1", label: "UP", lmsrProbability: 0, sortOrder: 0, isWinner: false },
          { id: "o2", label: "DOWN", lmsrProbability: 0, sortOrder: 1, isWinner: true },
        ],
      },
    });

    const a = await svc.getAnswer("m1");

    // The result is a fact, not a crowd estimate — it survives zero volume.
    expect(a.headline).toBe("Resolved: DOWN");
    expect(a.settled).toBe(true);
  });

  it("treats a distribution that does not sum to 1 as no answer", async () => {
    const { svc } = build({
      market: {
        id: "m1",
        title: "Half-initialised",
        category: "other",
        status: MarketStatus.OPEN,
        totalPool: 0,
        resolutionCriteria: null,
        evidenceUrl: null,
        evidenceNote: null,
        closesAt: null,
        resolvedAt: null,
        outcomes: [
          { id: "o1", label: "A", lmsrProbability: 0.02, sortOrder: 0, isWinner: false },
          { id: "o2", label: "B", lmsrProbability: 0, sortOrder: 1, isWinner: false },
        ],
      },
    });

    const a = await svc.getAnswer("m1");

    expect(a.hasAnswer).toBe(false);
  });

  it("reports an answer as soon as the distribution is real", async () => {
    const { svc } = build();

    const a = await svc.getAnswer("m1");

    expect(a.hasAnswer).toBe(true);
    expect(a.headline).toBe("Oro says 73% Yes");
  });

  it("404s on an unknown market", async () => {
    const { svc } = build({ market: null });

    await expect(svc.getAnswer("nope")).rejects.toThrow(NotFoundException);
  });
});
