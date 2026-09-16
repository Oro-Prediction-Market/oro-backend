/**
 * Tests for the share-card staging route.
 *
 * The behaviour this exists for — an image actually arriving in a Telegram chat
 * on Android — cannot be tested here: it needs Telegram to fetch the URL from
 * the public internet and a real Android client to send it. So these cover the
 * parts that are checkable, and in particular the three things that would fail
 * silently in production: a non-JPEG accepted and rejected later by Telegram, a
 * missing `Cross-Origin-Resource-Policy` header (helmet's global `same-origin`
 * makes Telegram's fetch fail), and a prepared message minted against a URL
 * nobody can reach.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  ShareCardController,
  ShareCardPublicController,
} from "../share/share-card.controller";
import { ShareCardService } from "../share/share-card.service";

// A minimal but genuine JPEG header: SOI + APP0.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    setEx: jest.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
    }),
  };
}

function makeSetup(opts: { telegramId?: string | null } = {}) {
  const redis = makeRedis();
  const cards = new ShareCardService(redis as any);
  const telegram = {
    savePreparedInlineMessage: jest.fn(async (_opts: any) => "prep-1"),
  };
  const userRepo = {
    findOne: jest.fn(async () => ({
      id: "u1",
      telegramId: opts.telegramId === undefined ? "555" : opts.telegramId,
    })),
  };
  const controller = new ShareCardController(
    cards,
    telegram as any,
    userRepo as any,
  );
  const publicController = new ShareCardPublicController(cards);
  return { redis, cards, telegram, controller, publicController };
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    end: jest.fn(),
  };
}

const REQ = { user: { userId: "u1" } };

describe("ShareCardService", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("identifies a JPEG by its magic bytes, not by what it was told", () => {
    expect(ShareCardService.looksLikeJpeg(JPEG)).toBe(true);
    expect(ShareCardService.looksLikeJpeg(PNG)).toBe(false);
    expect(ShareCardService.looksLikeJpeg(Buffer.alloc(0))).toBe(false);
  });

  it("falls back to the webhook origin so dev works through the existing tunnel", () => {
    const { cards } = makeSetup();
    delete process.env.PUBLIC_API_URL;
    process.env.TELEGRAM_WEBHOOK_URL = "https://tunnel.example.com/hook/secret/path";
    expect(cards.publicBaseUrl()).toBe("https://tunnel.example.com");
  });

  it("prefers PUBLIC_API_URL and strips a trailing slash", () => {
    const { cards } = makeSetup();
    process.env.PUBLIC_API_URL = "https://api.oro.fun/";
    process.env.TELEGRAM_WEBHOOK_URL = "https://tunnel.example.com/hook";
    expect(cards.urlFor("abc")).toBe("https://api.oro.fun/api/share-card/abc.jpg");
  });

  it("reports no URL when nothing public is configured", () => {
    const { cards } = makeSetup();
    delete process.env.PUBLIC_API_URL;
    delete process.env.TELEGRAM_WEBHOOK_URL;
    expect(cards.urlFor("abc")).toBeNull();
  });

  it("round-trips the bytes it was given", async () => {
    const { cards } = makeSetup();
    const id = await cards.store(JPEG);
    expect(await cards.read(id)).toEqual(JPEG);
  });

  it("returns null once the key has expired", async () => {
    const { cards, redis } = makeSetup();
    const id = await cards.store(JPEG);
    redis.store.clear(); // what a TTL expiry looks like
    expect(await cards.read(id)).toBeNull();
  });
});

describe("ShareCardController.stage", () => {
  beforeEach(() => {
    process.env.PUBLIC_API_URL = "https://api.oro.fun";
  });

  it("stages a JPEG and returns the prepared message id", async () => {
    const { controller, telegram } = makeSetup();

    const out = await controller.stage(REQ as any, {
      image: JPEG.toString("base64"),
      caption: "Predict this",
      buttonText: "Open on Oro",
      buttonUrl: "https://t.me/OroPredictBot?startapp=m_1",
    });

    expect(out).toEqual({ preparedMessageId: "prep-1" });
    const call = telegram.savePreparedInlineMessage.mock.calls[0]![0] as any;
    expect(call.userId).toBe(555);
    expect(call.photoUrl).toMatch(
      /^https:\/\/api\.oro\.fun\/api\/share-card\/[0-9a-f-]+\.jpg$/,
    );
    expect(call.button).toEqual({
      text: "Open on Oro",
      url: "https://t.me/OroPredictBot?startapp=m_1",
    });
  });

  it("accepts a data: URL, since that is what the canvas hands the caller", async () => {
    const { controller, telegram } = makeSetup();
    await controller.stage(REQ as any, {
      image: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
      caption: "x",
    });
    expect(telegram.savePreparedInlineMessage).toHaveBeenCalled();
  });

  it("rejects a PNG rather than letting Telegram fail at send time", async () => {
    const { controller, telegram } = makeSetup();
    await expect(
      controller.stage(REQ as any, { image: PNG.toString("base64") }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(telegram.savePreparedInlineMessage).not.toHaveBeenCalled();
  });

  it("rejects an oversized image", async () => {
    const { controller } = makeSetup();
    const big = Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]);
    await expect(
      controller.stage(REQ as any, { image: big.toString("base64") }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an empty body", async () => {
    const { controller } = makeSetup();
    await expect(controller.stage(REQ as any, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses an account with no Telegram id instead of guessing one", async () => {
    // DK Bank and BhutanApp sign-ups have no telegramId; the client falls back
    // to its native share path for these.
    const { controller, telegram } = makeSetup({ telegramId: null });
    await expect(
      controller.stage(REQ as any, { image: JPEG.toString("base64") }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(telegram.savePreparedInlineMessage).not.toHaveBeenCalled();
  });

  it("does not mint a prepared message pointing at an unreachable URL", async () => {
    const { controller, telegram } = makeSetup();
    delete process.env.PUBLIC_API_URL;
    delete process.env.TELEGRAM_WEBHOOK_URL;
    await expect(
      controller.stage(REQ as any, { image: JPEG.toString("base64") }),
    ).rejects.toThrow(/public URL/i);
    expect(telegram.savePreparedInlineMessage).not.toHaveBeenCalled();
  });
});

describe("ShareCardPublicController", () => {
  it("serves the bytes with the headers Telegram needs", async () => {
    const { cards, publicController } = makeSetup();
    const id = await cards.store(JPEG);
    const res = makeRes();

    await publicController.card(id, res as any);

    expect(res.end).toHaveBeenCalledWith(JPEG);
    expect(res.headers["Content-Type"]).toBe("image/jpeg");
    // Without this, helmet's global same-origin policy makes Telegram's fetch
    // fail — and it fails invisibly, only from Telegram's side.
    expect(res.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
  });

  it("404s an unknown or expired id rather than erroring", async () => {
    const { publicController } = makeSetup();
    await expect(
      publicController.card("nope", makeRes() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
