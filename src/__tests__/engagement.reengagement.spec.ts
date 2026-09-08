import { EngagementJob } from "../jobs/engagement.job";

/**
 * Re-engagement ladder.
 *
 * The bug these guard: the old query filtered `totalPredictions > 0` and keyed
 * off a one-calendar-day `lastActiveAt BETWEEN` window. That meant a user who
 * signed up and never placed a bet was never messaged at any milestone (their
 * `lastActiveAt` is null forever, and the filter excluded them anyway), and a
 * cron run that was missed took its cohort with it permanently.
 */
describe("EngagementJob re-engagement ladder", () => {
  type FakeUser = {
    id: string;
    telegramChatId: string | null;
    firstName: string | null;
    reputationTier: string | null;
  };

  /**
   * Records every milestone query the job builds and answers it from `byQuery`,
   * keyed by `${cohort}:${daysQuiet}`. The claim UPDATE echoes back whatever ids
   * it was given unless `claimNothing` is set.
   */
  function build(
    byQuery: Record<string, FakeUser[]>,
    opts: {
      claimNothing?: boolean;
      marketTitle?: string | null;
      predictorCount?: number;
      bhutanUserIds?: string[];
    } = {},
  ) {
    const seen: { cohort: string; daysQuiet: number; where: string[] }[] = [];
    const claims: { ids: string[]; stage: number }[] = [];

    const selectBuilder = () => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      const qb: any = {
        select: () => qb,
        where: (w: string, p?: Record<string, unknown>) => {
          where.push(w);
          Object.assign(params, p ?? {});
          return qb;
        },
        andWhere: (w: string, p?: Record<string, unknown>) => {
          where.push(w);
          Object.assign(params, p ?? {});
          return qb;
        },
        orderBy: () => qb,
        take: () => qb,
        getMany: async () => {
          const cohort = where.some((w) => w.includes("u.totalPredictions = 0"))
            ? "no_first_call"
            : "lapsed";
          const daysQuiet = Number(params.daysQuiet);
          seen.push({ cohort, daysQuiet, where: [...where] });
          return byQuery[`${cohort}:${daysQuiet}`] ?? [];
        },
      };
      return qb;
    };

    const updateBuilder = () => {
      let stage = 0;
      let ids: string[] = [];
      const qb: any = {
        update: () => qb,
        set: (v: { reengagementStage: number }) => {
          stage = v.reengagementStage;
          return qb;
        },
        whereInIds: (v: string[]) => {
          ids = v;
          return qb;
        },
        andWhere: () => qb,
        returning: () => qb,
        execute: async () => {
          claims.push({ ids, stage });
          return {
            raw: opts.claimNothing ? [] : ids.map((id) => ({ id })),
            affected: opts.claimNothing ? 0 : ids.length,
          };
        },
      };
      return qb;
    };

    const userRepo = {
      createQueryBuilder: (alias?: string) =>
        alias ? selectBuilder() : updateBuilder(),
      find: jest.fn().mockResolvedValue([]),
    };

    // Top open market for the curiosity-gap line.
    const marketTitle =
      opts.marketTitle === undefined ? "Bhutan vs Nepal" : opts.marketTitle;
    const marketRepo = {
      createQueryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: () => qb,
          orderBy: () => qb,
          limit: () => qb,
          getOne: async () =>
            marketTitle ? { id: "m1", title: marketTitle } : null,
        };
        return qb;
      },
    };

    // DISTINCT participant count backing the social-proof line.
    const dataSource = {
      getRepository: () => ({
        createQueryBuilder: () => {
          const qb: any = {
            select: () => qb,
            where: () => qb,
            getRawOne: async () => ({ c: String(opts.predictorCount ?? 0) }),
          };
          return qb;
        },
      }),
    };

    const authRepo = {
      findBy: jest.fn().mockResolvedValue(
        (opts.bhutanUserIds ?? []).map((userId) => ({
          userId,
          providerId: `ext-${userId}`,
          metadata: null,
        })),
      ),
    };

    const telegram = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      acquireLock: jest.fn().mockResolvedValue("token"),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const userNotifications = { create: jest.fn().mockResolvedValue(undefined) };
    const queue = { addBulk: jest.fn().mockResolvedValue(undefined) };

    const job = new EngagementJob(
      userRepo as any,
      {} as any,
      marketRepo as any,
      authRepo as any,
      dataSource as any,
      telegram as any,
      redis as any,
      userNotifications as any,
      queue as any,
    );

    return {
      job,
      telegram,
      seen,
      claims,
      redis,
      userNotifications,
      queue,
      authRepo,
    };
  }

  const user = (id: string, over: Partial<FakeUser> = {}): FakeUser => ({
    id,
    telegramChatId: "555",
    firstName: "Karma",
    reputationTier: null,
    ...over,
  });

  it("messages a user who signed up and never placed a prediction", async () => {
    const { job, telegram, claims } = build({
      "no_first_call:1": [user("u1")],
    });

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith(555, expect.any(String));
    expect(claims).toEqual([{ ids: ["u1"], stage: 1 }]);
  });

  it("anchors the no-first-call cohort on createdAt, not lastActiveAt", async () => {
    const { job, seen } = build({});

    await job.reEngageLapsedUsers();

    const neverBet = seen.filter((q) => q.cohort === "no_first_call");
    expect(neverBet.length).toBeGreaterThan(0);
    for (const q of neverBet) {
      expect(q.where.some((w) => w.includes("u.createdAt <="))).toBe(true);
      expect(q.where.some((w) => w.includes("u.lastActiveAt"))).toBe(false);
    }
  });

  it("walks the no-first-call ladder at 1, 3 and 7 days and the lapsed ladder at 3, 7, 14 and 30", async () => {
    const { job, seen } = build({});

    await job.reEngageLapsedUsers();

    expect(
      seen.filter((q) => q.cohort === "no_first_call").map((q) => q.daysQuiet),
    ).toEqual([7, 3, 1]);
    expect(
      seen.filter((q) => q.cohort === "lapsed").map((q) => q.daysQuiet),
    ).toEqual([30, 14, 7, 3]);
  });

  it("guards every milestone query on the stored stage so a missed run is picked up later", async () => {
    const { job, seen } = build({});

    await job.reEngageLapsedUsers();

    for (const q of seen) {
      expect(
        q.where.some(
          (w) =>
            w.includes("u.reengagementStage IS NULL") &&
            w.includes("u.reengagementStage < :daysQuiet"),
        ),
      ).toBe(true);
    }
  });

  it("sends the longest-quiet milestone first so a backlog is not a burst of DMs", async () => {
    // Same user is eligible at 30 and 14; the 30 pass claims them, and in
    // production the stamp then excludes them from 14. Assert 30 ran first.
    const { job, claims } = build({
      "lapsed:30": [user("u1")],
    });

    await job.reEngageLapsedUsers();

    expect(claims[0].stage).toBe(30);
  });

  it("does not DM a user whose row was already claimed by another run", async () => {
    const { job, telegram } = build(
      { "no_first_call:3": [user("u1")] },
      { claimNothing: true },
    );

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("nudges a PWA user with no Telegram chat via in-app and BhutanApp push", async () => {
    const { job, telegram, claims, userNotifications, queue } = build(
      { "no_first_call:7": [user("u1", { telegramChatId: null })] },
      { bhutanUserIds: ["u1"] },
    );

    await job.reEngageLapsedUsers();

    // No Telegram, but the user is still reached and still claimed.
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(claims).toEqual([{ ids: ["u1"], stage: 7 }]);
    expect(userNotifications.create).toHaveBeenCalledTimes(1);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0][0]).toEqual([
      {
        name: "bhutanapp.notify",
        data: {
          externalUserId: "ext-u1",
          title: expect.any(String),
          body: expect.any(String),
        },
      },
    ]);
  });

  it("still reaches a user with neither Telegram nor BhutanApp through the in-app bell", async () => {
    const { job, telegram, queue, userNotifications, claims } = build({
      "no_first_call:3": [user("u1", { telegramChatId: null })],
    });

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(userNotifications.create).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        type: "reengagement",
        metadata: { cohort: "no_first_call", daysQuiet: 3 },
      }),
    );
    expect(claims).toEqual([{ ids: ["u1"], stage: 3 }]);
  });

  it("writes an in-app notification for every user, on every channel combination", async () => {
    const { job, userNotifications } = build(
      {
        "no_first_call:1": [
          user("u1"),
          user("u2", { telegramChatId: null }),
          user("u3"),
        ],
      },
      { bhutanUserIds: ["u2"] },
    );

    await job.reEngageLapsedUsers();

    expect(userNotifications.create).toHaveBeenCalledTimes(3);
  });

  it("strips HTML from push and in-app bodies but keeps it in the Telegram DM", async () => {
    const { job, telegram, userNotifications } = build({
      "lapsed:7": [user("u1", { reputationTier: "legend" })],
    });

    await job.reEngageLapsedUsers();

    const dm = telegram.sendMessage.mock.calls[0][1] as string;
    const inApp = userNotifications.create.mock.calls[0][1].body as string;
    expect(dm).toContain("<b>Legend</b>");
    expect(inApp).toContain("Legend");
    expect(inApp).not.toMatch(/<[^>]+>/);
  });

  it("puts the live market in front of the no-first-call cohort", async () => {
    const { job, telegram } = build(
      { "no_first_call:1": [user("u1")] },
      { marketTitle: "Bhutan vs Nepal" },
    );

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage.mock.calls[0][1]).toContain("Bhutan vs Nepal");
  });

  it("falls back to copy that stands alone when no market is open", async () => {
    const { job, telegram } = build(
      { "no_first_call:1": [user("u1")] },
      { marketTitle: null },
    );

    await job.reEngageLapsedUsers();

    const msg = telegram.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("Karma");
    expect(msg).not.toContain("undefined");
    expect(msg).not.toContain("null");
  });

  it("claims social proof only when the crowd is real", async () => {
    const quiet = build(
      { "no_first_call:1": [user("u1")] },
      { predictorCount: 1 },
    );
    await quiet.job.reEngageLapsedUsers();
    expect(quiet.telegram.sendMessage.mock.calls[0][1]).not.toMatch(
      /have taken a side/,
    );

    const busy = build(
      { "no_first_call:1": [user("u1")] },
      { predictorCount: 42 },
    );
    await busy.job.reEngageLapsedUsers();
    expect(busy.telegram.sendMessage.mock.calls[0][1]).toContain(
      "42 people have taken a side",
    );
  });

  it("keeps sending to the rest of the batch when one DM fails", async () => {
    const { job, telegram } = build({
      "no_first_call:1": [user("u1"), user("u2", { telegramChatId: "777" })],
    });
    telegram.sendMessage
      .mockRejectedValueOnce(new Error("bot was blocked by the user"))
      .mockResolvedValueOnce(undefined);

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("never promises free credit, and never frames a nudge as a bet", async () => {
    // Every rung of both ladders, so no single message can drift.
    const { job, telegram, userNotifications } = build({
      "no_first_call:1": [user("u1")],
      "no_first_call:3": [user("u2")],
      "no_first_call:7": [user("u3")],
      "lapsed:3": [user("u4")],
      "lapsed:7": [user("u5", { reputationTier: "hot_hand" })],
      "lapsed:14": [user("u6", { reputationTier: "legend" })],
      "lapsed:30": [user("u7")],
    });

    await job.reEngageLapsedUsers();

    const bodies = [
      ...telegram.sendMessage.mock.calls.map((c) => c[1] as string),
      ...userNotifications.create.mock.calls.map(
        (c) => `${c[1].title} ${c[1].body}`,
      ),
    ];
    expect(bodies.length).toBeGreaterThan(0);
    for (const msg of bodies) {
      // No credit we do not actually grant.
      expect(msg).not.toMatch(/free|bonus|Nu\s*\d/i);
      // No gambling framing — a prediction is a "call", never a wager.
      expect(msg).not.toMatch(/\bbets?\b|\bbetting\b|\bwager\b|\bgambl/i);
    }
  });

  it("does nothing when the cron lock is already held", async () => {
    const { job, telegram, redis } = build({ "no_first_call:1": [user("u1")] });
    redis.acquireLock.mockResolvedValue(null);

    await job.reEngageLapsedUsers();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
