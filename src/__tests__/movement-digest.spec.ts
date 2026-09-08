import { MovementDigestJob } from "../insights/movement-digest.job";

/**
 * Two audiences on purpose: the channel gets the whole digest because a list of
 * what moved is the product; an individual only hears about markets they
 * actually called, because a buzz about a market someone has never looked at is
 * what teaches them to mute the bell.
 */
describe("MovementDigestJob", () => {
  function build(opts: {
    movers?: any[];
    positions?: any[];
    calls?: any[];
    lock?: string | null;
    channelId?: string | null;
  } = {}) {
    const positionRepo: any = {
      find: jest.fn(async () => opts.positions ?? []),
    };
    const freeCallRepo: any = { find: jest.fn(async () => opts.calls ?? []) };
    const history: any = { getMovers: jest.fn(async () => opts.movers ?? []) };
    const redis: any = {
      acquireLock: jest
        .fn()
        .mockResolvedValue(opts.lock === undefined ? "t" : opts.lock),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const userNotifications: any = {
      create: jest.fn().mockResolvedValue(undefined),
    };
    const telegram: any = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    const config: any = {
      get: jest.fn(() =>
        opts.channelId === undefined ? "-1001234567890" : opts.channelId,
      ),
    };

    const job = new MovementDigestJob(
      positionRepo,
      freeCallRepo,
      history,
      redis,
      userNotifications,
      telegram,
      config,
    );
    return { job, userNotifications, telegram, history };
  }

  const mover = (marketId: string, delta: number, to: number) => ({
    marketId,
    title: `Question ${marketId}`,
    category: "sports",
    outcomeId: `${marketId}-o1`,
    outcomeLabel: "Yes",
    from: to - delta,
    to,
    delta,
    totalPool: 5000,
  });

  it("posts the digest to the public channel", async () => {
    const { job, telegram } = build({
      movers: [mover("m1", 0.13, 0.73), mover("m2", -0.09, 0.31)],
    });

    await job.postDailyMovement();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const [target, message] = telegram.sendMessage.mock.calls[0];
    // A numeric channel id must go out as a number, not the config string.
    expect(target).toBe(-1001234567890);
    expect(message).toContain("What changed today");
    expect(message).toContain("Question m1");
    expect(message).toContain("73%");
    expect(message).toContain("13pp");
    // Direction is shown, not just magnitude.
    expect(message).toContain("▲");
    expect(message).toContain("▼");
  });

  it("addresses a channel given as @name without mangling it", async () => {
    const { job, telegram } = build({
      movers: [mover("m1", 0.13, 0.73)],
      channelId: "@oropredict",
    });

    await job.postDailyMovement();

    expect(telegram.sendMessage.mock.calls[0][0]).toBe("@oropredict");
  });

  it("still notifies interested users when no channel is configured", async () => {
    const { job, telegram, userNotifications } = build({
      movers: [mover("m1", 0.13, 0.73)],
      positions: [{ userId: "u1", marketId: "m1" }],
      channelId: null,
    });

    await job.postDailyMovement();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(userNotifications.create).toHaveBeenCalledTimes(1);
  });

  it("still notifies interested users when the channel post fails", async () => {
    const { job, telegram, userNotifications } = build({
      movers: [mover("m1", 0.13, 0.73)],
      positions: [{ userId: "u1", marketId: "m1" }],
    });
    telegram.sendMessage.mockRejectedValue(new Error("bot is not an admin"));

    await job.postDailyMovement();

    expect(userNotifications.create).toHaveBeenCalledTimes(1);
  });

  it("stays quiet entirely when nothing moved enough", async () => {
    const { job, telegram, userNotifications } = build({ movers: [] });

    await job.postDailyMovement();

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(userNotifications.create).not.toHaveBeenCalled();
  });

  it("notifies only users who called a market that moved", async () => {
    const { job, userNotifications } = build({
      movers: [mover("m1", 0.2, 0.8)],
      positions: [{ userId: "u1", marketId: "m1" }],
      calls: [{ userId: "u2", marketId: "m1" }],
    });

    await job.postDailyMovement();

    const notified = userNotifications.create.mock.calls.map((c: any[]) => c[0]);
    expect(notified.sort()).toEqual(["u1", "u2"]);
  });

  it("sends one notification per user, not one per market", async () => {
    const { job, userNotifications } = build({
      movers: [mover("m1", 0.2, 0.8), mover("m2", 0.3, 0.6), mover("m3", 0.1, 0.4)],
      positions: [
        { userId: "u1", marketId: "m1" },
        { userId: "u1", marketId: "m2" },
        { userId: "u1", marketId: "m3" },
      ],
    });

    await job.postDailyMovement();

    expect(userNotifications.create).toHaveBeenCalledTimes(1);
    const body = userNotifications.create.mock.calls[0][1].body as string;
    // Leads with the biggest move (m2, 30pp) and counts the rest.
    expect(body).toContain("Question m2");
    expect(body).toContain("2 other questions");
  });

  it("names the single market when that is all the user called", async () => {
    const { job, userNotifications } = build({
      movers: [mover("m1", -0.15, 0.35)],
      positions: [{ userId: "u1", marketId: "m1" }],
    });

    await job.postDailyMovement();

    const body = userNotifications.create.mock.calls[0][1].body as string;
    expect(body).toContain("moved down 15pp to 35%");
    expect(body).not.toContain("other question");
  });

  it("attaches the moves as metadata for the client to link", async () => {
    const { job, userNotifications } = build({
      movers: [mover("m1", 0.2, 0.8)],
      calls: [{ userId: "u2", marketId: "m1" }],
    });

    await job.postDailyMovement();

    const payload = userNotifications.create.mock.calls[0][1];
    expect(payload.type).toBe("movement");
    expect(payload.metadata.markets[0]).toMatchObject({
      marketId: "m1",
      to: 0.8,
    });
  });

  it("does nothing when the cron lock is held", async () => {
    const { job, history, telegram } = build({
      movers: [mover("m1", 0.2, 0.8)],
      lock: null,
    });

    await job.postDailyMovement();

    expect(history.getMovers).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
