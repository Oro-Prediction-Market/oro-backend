/**
 * Tests for admin broadcasts.
 *
 * The behaviour that matters here cannot be observed after the fact: a broadcast
 * reaches ~2,200 real people at once and cannot be recalled. So these cover the
 * things whose failure would only ever be discovered by sending something twice,
 * or by sending from a laptop.
 *
 * In particular: the fan-out guard, because NODE_ENV is baked into the
 * production image and is therefore true on a developer's machine too; and the
 * idempotency chain, because a double-clicked Send is not a hypothetical.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { AnnouncementsService } from "../admin/announcements.service";
import {
  evaluateFanOut,
  TEST_MODE_MAX_RECIPIENTS,
} from "../shared/utils/broadcast-guard.util";
import { isPermanentDeliveryFailure } from "../shared/utils/announcement-stats.util";

const PROD_BOT = "8924901746";
const TEST_BOT = "1234567890";

describe("evaluateFanOut — the dev-laptop guard", () => {
  it("allows the production cluster", () => {
    expect(
      evaluateFanOut({
        TELEGRAM_BOT_TOKEN: `${PROD_BOT}:secret`,
        NODE_ENV: "production",
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
      } as any),
    ).toEqual({ allowed: true, mode: "live" });
  });

  it("REFUSES a laptop running the prod image with the prod token", () => {
    // The case that matters. NODE_ENV=production is baked into Dockerfile:36, so
    // it is true for anyone running that image locally — which is exactly what a
    // developer does when chasing a production bug. Without the cluster check
    // this would have been allowed.
    const v = evaluateFanOut({
      TELEGRAM_BOT_TOKEN: `${PROD_BOT}:secret`,
      NODE_ENV: "production",
    } as any);
    expect(v.allowed).toBe(false);
  });

  it("refuses a plain dev machine holding the prod token", () => {
    expect(
      evaluateFanOut({
        TELEGRAM_BOT_TOKEN: `${PROD_BOT}:secret`,
        NODE_ENV: "development",
      } as any).allowed,
    ).toBe(false);
  });

  it("allows a test bot, capped — Telegram bounds the rest", () => {
    // A bot cannot open a conversation with someone who never started it, so the
    // real audience is the developer themselves.
    expect(
      evaluateFanOut({
        TELEGRAM_BOT_TOKEN: `${TEST_BOT}:secret`,
        NODE_ENV: "development",
      } as any),
    ).toEqual({
      allowed: true,
      mode: "test",
      maxRecipients: TEST_MODE_MAX_RECIPIENTS,
    });
  });

  it("refuses when no token is configured at all", () => {
    expect(evaluateFanOut({ NODE_ENV: "development" } as any).allowed).toBe(false);
  });

  it("is not defeated by an env flag, because there isn't one", () => {
    // Guarding the guard: a future ALLOW_BROADCAST left set in someone's .env is
    // the same failure that caused the September incident.
    expect(
      evaluateFanOut({
        TELEGRAM_BOT_TOKEN: `${PROD_BOT}:secret`,
        NODE_ENV: "development",
        ALLOW_BROADCAST: "true",
        BROADCAST_ENABLED: "1",
      } as any).allowed,
    ).toBe(false);
  });
});

describe("composeMessage", () => {
  it("escapes HTML so one stray character cannot fail every DM", () => {
    // sendMessage uses parse_mode: "HTML". An unescaped "<3" returns
    // 400 can't parse entities for EVERY recipient, not just one.
    const msg = AnnouncementsService.composeMessage("Patch <1.2>", "we <3 you & you");
    expect(msg).toBe("<b>Patch &lt;1.2&gt;</b>\n\nwe &lt;3 you &amp; you");
    expect(msg).not.toMatch(/[^;]<3/);
  });

  it("escapes the ampersand before the angle brackets", () => {
    // Order matters: escaping < first would turn "&lt;" into "&amp;lt;".
    expect(AnnouncementsService.composeMessage("t", "<")).toContain("&lt;");
    expect(AnnouncementsService.composeMessage("t", "<")).not.toContain("&amp;lt;");
  });
});

describe("contentHash", () => {
  it("is stable for identical content and differs otherwise", () => {
    const a = AnnouncementsService.contentHash("Title", "Body");
    expect(a).toBe(AnnouncementsService.contentHash("Title", "Body"));
    expect(a).not.toBe(AnnouncementsService.contentHash("Title", "Body "));
  });

  it("does not collide when the split between title and body moves", () => {
    expect(AnnouncementsService.contentHash("a\nb", "c")).not.toBe(
      AnnouncementsService.contentHash("a", "b\nc"),
    );
  });
});

describe("isPermanentDeliveryFailure", () => {
  it("treats a blocked bot as terminal", () => {
    expect(
      isPermanentDeliveryFailure({ code: 403, description: "bot was blocked by the user" }),
    ).toBe(true);
  });

  it("treats a deleted chat as terminal", () => {
    expect(isPermanentDeliveryFailure({ code: 400, description: "chat not found" })).toBe(true);
  });

  it("does NOT treat a rate limit as terminal", () => {
    // Retrying a 429 is the whole point of the backoff.
    expect(isPermanentDeliveryFailure({ code: 429, description: "Too Many Requests" })).toBe(false);
  });

  it("does not treat a network error as terminal", () => {
    expect(isPermanentDeliveryFailure({ description: "fetch failed" })).toBe(false);
  });

  it("does not treat an unrelated 400 as terminal", () => {
    expect(
      isPermanentDeliveryFailure({ code: 400, description: "message is too long" }),
    ).toBe(false);
  });
});

// ── The service, with everything around it faked ───────────────────────────

function makeService(opts: {
  env?: Record<string, string>;
  users?: Array<{ id: string; chat?: string | null; tg?: string | null }>;
  existingByRequestId?: any;
  insertReturns?: Array<{ id: string }>;
  insertError?: any;
  recentDuplicate?: any;
  preflightOk?: boolean;
  isAdmin?: boolean;
} = {}) {
  const users = opts.users ?? [
    { id: "u1", chat: "111", tg: "111" },
    { id: "u2", chat: null, tg: "222" },
    { id: "u3", chat: null, tg: null },
  ];

  const repoUpdate = jest.fn(async () => ({ affected: 1 }));
  const repo = {
    save: jest.fn(async (x: any) => ({ ...x, id: "blocked-1" })),
    create: jest.fn((x: any) => x),
    update: repoUpdate,
    findOneBy: jest.fn(async () => opts.existingByRequestId ?? null),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => opts.recentDuplicate ?? null),
    })),
  };

  const userRepo = {
    findOne: jest.fn(async () => ({
      id: "admin-1",
      isAdmin: opts.isAdmin !== false,
      telegramChatId: "999",
      telegramId: "999",
    })),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => users),
    })),
  };

  const dataSource = {
    query: jest.fn(async () => {
      if (opts.insertError) throw opts.insertError;
      return opts.insertReturns ?? [{ id: "ann-1" }];
    }),
    transaction: jest.fn(async (cb: any) =>
      cb({
        getRepository: () => ({ update: repoUpdate, insert: jest.fn() }),
      }),
    ),
  };

  // Parameters are declared on the mocks so `mock.calls[0][1]` is typed as
  // something rather than as an empty tuple.
  const notifications = {
    createBulk: jest.fn(async (_m: any, rows: any[]) => rows.length),
    removeByAnnouncement: jest.fn(async (_id: string) => 7),
  };
  const telegram = {
    sendMessageChecked: jest.fn(async () =>
      opts.preflightOk === false
        ? { ok: false, code: 400, description: "can't parse entities" }
        : { ok: true },
    ),
  };
  const queue = {
    add: jest.fn(async (_name: string, _data: any, _opts?: any) => {}),
    addBulk: jest.fn(async (_jobs: any[]) => {}),
  };
  const redis = { redis: {} };

  const env = {
    TELEGRAM_BOT_TOKEN: `${TEST_BOT}:secret`,
    NODE_ENV: "development",
    ...(opts.env ?? {}),
  };
  const prev = process.env;
  process.env = { ...prev, ...env } as any;

  const svc = new AnnouncementsService(
    repo as any,
    userRepo as any,
    dataSource as any,
    notifications as any,
    telegram as any,
    redis as any,
    queue as any,
  );

  return {
    svc,
    repo,
    userRepo,
    dataSource,
    notifications,
    telegram,
    queue,
    restoreEnv: () => {
      process.env = prev;
    },
  };
}

const BASE = {
  adminId: "admin-1",
  title: "Patch notes",
  body: "We shipped things.",
  clientRequestId: "req-1",
};

describe("AnnouncementsService.send", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  it("refuses and records the attempt when the guard says no", async () => {
    const h = makeService({
      env: { TELEGRAM_BOT_TOKEN: `${PROD_BOT}:s`, NODE_ENV: "development" },
    });
    restore = h.restoreEnv;

    await expect(h.svc.send({ ...BASE })).rejects.toMatchObject({ status: 503 });

    // Nothing sent, but a row exists: you want a record that a laptop tried.
    expect(h.repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked" }),
    );
    expect(h.queue.addBulk).not.toHaveBeenCalled();
    expect(h.notifications.createBulk).not.toHaveBeenCalled();
  });

  it("sends in-app rows to everyone and DMs only the reachable", async () => {
    const h = makeService();
    restore = h.restoreEnv;

    const out = await h.svc.send({ ...BASE });

    expect(out).toEqual({ id: "ann-1", status: "sending" });
    // All three users get a bell row...
    expect(h.notifications.createBulk).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ userId: "u1", type: "announcement" }),
        expect.objectContaining({ userId: "u3" }),
      ]),
    );
    expect(h.notifications.createBulk.mock.calls[0]![1]).toHaveLength(3);
    // ...but only the two with a usable chat id get a DM.
    expect(h.queue.addBulk).toHaveBeenCalled();
    expect(h.queue.addBulk.mock.calls[0]![0]).toHaveLength(2);
  });

  it("stamps every row with the announcement id so it can be retracted", async () => {
    const h = makeService();
    restore = h.restoreEnv;
    await h.svc.send({ ...BASE });
    const rows = h.notifications.createBulk.mock.calls[0]![1] as any[];
    expect(rows.every((r) => r.metadata.announcementId === "ann-1")).toBe(true);
  });

  it("gives announcement DMs a lower priority than settlement DMs", async () => {
    const h = makeService();
    restore = h.restoreEnv;
    await h.svc.send({ ...BASE });
    const jobs = h.queue.addBulk.mock.calls[0]![0] as any[];
    // Settlement uses the default priority 0; higher number = lower priority, so
    // a market settling mid-broadcast is not stuck behind 2,199 jobs.
    expect(jobs[0].opts.priority).toBe(10);
    // Two attempts, not the global three: a blocked user is handled explicitly.
    expect(jobs[0].opts.attempts).toBe(2);
  });

  it("dedupes two accounts that share one Telegram id", async () => {
    // An account merge leaves these behind. One human should get one DM.
    const h = makeService({
      users: [
        { id: "u1", chat: "111", tg: "111" },
        { id: "u2", chat: "111", tg: "111" },
      ],
    });
    restore = h.restoreEnv;
    await h.svc.send({ ...BASE });
    expect(h.notifications.createBulk.mock.calls[0]![1]).toHaveLength(2);
    expect(h.queue.addBulk.mock.calls[0]![0]).toHaveLength(1);
  });

  it("drops junk chat ids rather than enqueuing them", async () => {
    // Both columns are varchar and hold rubbish in places.
    const h = makeService({
      users: [
        { id: "u1", chat: "not-a-number", tg: null },
        { id: "u2", chat: "0", tg: null },
        { id: "u3", chat: "-5", tg: null },
        { id: "u4", chat: "777", tg: null },
      ],
    });
    restore = h.restoreEnv;
    await h.svc.send({ ...BASE });
    expect(h.queue.addBulk.mock.calls[0]![0]).toHaveLength(1);
  });

  it("returns the original and sends nothing on a repeated request id", async () => {
    // The double-clicked Send.
    const h = makeService({
      insertReturns: [],
      existingByRequestId: { id: "ann-1", status: "sending" },
    });
    restore = h.restoreEnv;

    const out = await h.svc.send({ ...BASE });

    expect(out).toEqual({ id: "ann-1", status: "sending", duplicate: true });
    expect(h.queue.addBulk).not.toHaveBeenCalled();
    expect(h.notifications.createBulk).not.toHaveBeenCalled();
  });

  it("rejects a second broadcast while one is in flight", async () => {
    const h = makeService({ insertError: { code: "23505" } });
    restore = h.restoreEnv;
    await expect(h.svc.send({ ...BASE })).rejects.toBeInstanceOf(ConflictException);
    expect(h.queue.addBulk).not.toHaveBeenCalled();
  });

  it("refuses identical content sent minutes ago, unless forced", async () => {
    const h = makeService({ recentDuplicate: { id: "ann-0", status: "completed" } });
    restore = h.restoreEnv;
    await expect(h.svc.send({ ...BASE })).rejects.toBeInstanceOf(ConflictException);

    const h2 = makeService({ recentDuplicate: { id: "ann-0", status: "completed" } });
    await expect(h2.svc.send({ ...BASE, force: true })).resolves.toMatchObject({
      status: "sending",
    });
    h2.restoreEnv();
  });

  it("writes nothing when the pre-flight message is rejected", async () => {
    // A stray "<" would otherwise fail every single DM, after the rows were written.
    const h = makeService({ preflightOk: false });
    restore = h.restoreEnv;

    await expect(h.svc.send({ ...BASE })).rejects.toBeInstanceOf(BadRequestException);

    expect(h.notifications.createBulk).not.toHaveBeenCalled();
    expect(h.queue.addBulk).not.toHaveBeenCalled();
    expect(h.repo.update).toHaveBeenCalledWith(
      { id: "ann-1" },
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("refuses an admin whose privileges were revoked since their token was issued", async () => {
    // The JWT carries isAdmin for 8 hours; this capability should not.
    const h = makeService({ isAdmin: false });
    restore = h.restoreEnv;
    await expect(h.svc.send({ ...BASE })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.queue.addBulk).not.toHaveBeenCalled();
  });

  it("caps the audience in test mode", async () => {
    const h = makeService({
      env: { TELEGRAM_BOT_TOKEN: `${TEST_BOT}:s`, NODE_ENV: "development" },
    });
    restore = h.restoreEnv;
    await h.svc.send({ ...BASE });
    const qb = h.userRepo.createQueryBuilder.mock.results[0]!.value;
    expect(qb.limit).toHaveBeenCalledWith(TEST_MODE_MAX_RECIPIENTS);
  });
});

describe("AnnouncementsService.retract", () => {
  it("removes the in-app rows for that announcement", async () => {
    const h = makeService({ existingByRequestId: { id: "ann-1" } });
    h.repo.findOneBy = jest.fn(async () => ({ id: "ann-1" })) as any;
    const out = await h.svc.retract("ann-1");
    expect(out).toEqual({ removed: 7 });
    expect(h.notifications.removeByAnnouncement).toHaveBeenCalledWith("ann-1");
    h.restoreEnv();
  });
});
