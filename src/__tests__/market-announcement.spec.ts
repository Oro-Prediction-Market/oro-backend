import {
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MESSAGE_MAX,
  buildMarketAnnouncement,
  escapeTelegramHtml,
} from "../telegram/market-announcement";
import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { AdminController } from "../admin/admin.controller";

const input = (
  outcomes: string[],
  title = "Who will win 2026 Ballon d'Or?",
) => ({
  title,
  outcomes,
  closesAt: "Oct 26, 2026, 8:00 PM",
  link: "https://t.me/OroPredictBot?startapp=m_abc",
});

describe("buildMarketAnnouncement", () => {
  it("lists every outcome when it fits", () => {
    const text = buildMarketAnnouncement(
      input(["Messi", "Yamal"]),
      TELEGRAM_CAPTION_MAX,
    );
    expect(text).toContain("• Messi\n• Yamal");
    expect(text).not.toContain("more");
    expect(text).toContain(
      '<a href="https://t.me/OroPredictBot?startapp=m_abc">Predict Now</a>',
    );
  });

  it("shortens a long outcome list to fit a photo caption, saying how many are hidden", () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `Player number ${i + 1} with a long name`,
    );
    const caption = buildMarketAnnouncement(input(many), TELEGRAM_CAPTION_MAX);
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    const shown = (caption.match(/^• /gm) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(caption).toContain(`+${60 - shown} more`);
    expect(caption).toContain("Predict Now");

    const full = buildMarketAnnouncement(input(many), TELEGRAM_MESSAGE_MAX);
    expect((full.match(/^• /gm) ?? []).length).toBe(60);
  });

  it("escapes HTML so a title with & or < cannot break the post", () => {
    expect(escapeTelegramHtml("A & B <3 >")).toBe("A &amp; B &lt;3 &gt;");
    const text = buildMarketAnnouncement(
      input(["<b>x</b>"], "Bonds & Co"),
      TELEGRAM_CAPTION_MAX,
    );
    expect(text).toContain("<b>Bonds &amp; Co</b>");
    expect(text).toContain("• &lt;b&gt;x&lt;/b&gt;");
  });
});

describe("TelegramSimpleService.postPhotoToChannel", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.TELEGRAM_CHANNEL_ID = "@oro";
    process.env.TELEGRAM_BOT_TOKEN = "8924901746:dev"; // a development bot: sends allowed
  });
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  const service = () =>
    new TelegramSimpleService(
      { getOrThrow: () => process.env.TELEGRAM_BOT_TOKEN } as any,
      {} as any,
      {} as any,
    );

  it("sends an image URL for Telegram to fetch", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
    global.fetch = fetchMock as any;
    await expect(
      service().postPhotoToChannel("https://img.test/a.png", "cap"),
    ).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/sendPhoto$/);
    expect(JSON.parse(init.body)).toEqual({
      chat_id: "@oro",
      photo: "https://img.test/a.png",
      caption: "cap",
      parse_mode: "HTML",
    });
  });

  it("uploads an inline data-URI image as a file", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "" });
    global.fetch = fetchMock as any;
    const png = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    await expect(service().postPhotoToChannel(png, "cap")).resolves.toBe(true);
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("caption")).toBe("cap");
    expect(body.get("photo")).toBeInstanceOf(Blob);
  });

  it("reports failure instead of throwing, so the caller can fall back", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad",
      }) as any;
    await expect(
      service().postPhotoToChannel("https://img.test/a.png", "cap"),
    ).resolves.toBe(false);
    global.fetch = jest.fn().mockRejectedValue(new Error("network")) as any;
    await expect(
      service().postPhotoToChannel("https://img.test/a.png", "cap"),
    ).resolves.toBe(false);
    await expect(
      service().postPhotoToChannel("data:text/plain;base64,aGk=", "cap"),
    ).resolves.toBe(false);
  });
});

describe("AdminController.announceMarket", () => {
  function build(market: Record<string, unknown>, photoOk: boolean) {
    const ctrl = Object.create(AdminController.prototype) as any;
    ctrl.marketsService = {
      findOne: jest.fn().mockResolvedValue({
        id: "m1",
        title: "Who will win 2026 Ballon d'Or?",
        closesAt: null,
        outcomes: [{ label: "Messi" }, { label: "Yamal" }],
        ...market,
      }),
    };
    ctrl.telegramSimple = {
      postPhotoToChannel: jest.fn().mockResolvedValue(photoOk),
      postToChannel: jest.fn().mockResolvedValue(undefined),
    };
    ctrl.auditService = { log: jest.fn().mockResolvedValue(undefined) };
    return ctrl;
  }
  const req = { user: { userId: "admin-1" }, ip: "127.0.0.1" };

  it("posts the market's image with the text as its caption", async () => {
    const ctrl = build({ imageUrl: "https://img.test/bdo.png" }, true);
    await expect(ctrl.announceMarket("m1", req)).resolves.toEqual({
      success: true,
      withImage: true,
    });
    const [photo, caption] =
      ctrl.telegramSimple.postPhotoToChannel.mock.calls[0];
    expect(photo).toBe("https://img.test/bdo.png");
    expect(caption).toContain("• Messi\n• Yamal");
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    expect(ctrl.telegramSimple.postToChannel).not.toHaveBeenCalled();
  });

  it("falls back to the text post when the photo is refused", async () => {
    const ctrl = build({ imageUrl: "https://img.test/broken.png" }, false);
    await expect(ctrl.announceMarket("m1", req)).resolves.toEqual({
      success: true,
      withImage: false,
    });
    expect(ctrl.telegramSimple.postToChannel).toHaveBeenCalledTimes(1);
    expect(ctrl.telegramSimple.postToChannel.mock.calls[0][0]).toContain(
      "NEW MARKET",
    );
  });

  it("posts text only when the market has no image", async () => {
    const ctrl = build({ imageUrl: null }, true);
    await ctrl.announceMarket("m1", req);
    expect(ctrl.telegramSimple.postPhotoToChannel).not.toHaveBeenCalled();
    expect(ctrl.telegramSimple.postToChannel).toHaveBeenCalledTimes(1);
  });
});
