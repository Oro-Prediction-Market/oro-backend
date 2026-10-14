import { TelegramSimpleService } from "../telegram/telegram.service.simple";
import { BotPollingService } from "../bot/bot-polling.service";
import {
  isProductionCluster,
  mayMessageTelegramUsers,
} from "../shared/utils/broadcast-guard.util";

/**
 * A laptop holding the production bot token must not reach real users.
 *
 * In September 2026 a laptop's crons sent about 4,000 real Telegram DMs, and
 * its bot bootstrap re-pointed production's webhook. Only admin announcements
 * were guarded; these cover the ordinary send path and the bot itself.
 */
const PROD_TOKEN = "1234567890:prod-token-not-real";
const DEV_TOKEN = "8924901746:dev-token-not-real"; // @betmahind_bot

const LAPTOP_WITH_PROD_TOKEN = { TELEGRAM_BOT_TOKEN: PROD_TOKEN, NODE_ENV: "production" };
const LAPTOP_WITH_DEV_BOT = { TELEGRAM_BOT_TOKEN: DEV_TOKEN, NODE_ENV: "development" };
const CLUSTER = {
  TELEGRAM_BOT_TOKEN: PROD_TOKEN,
  NODE_ENV: "production",
  KUBERNETES_SERVICE_HOST: "10.0.0.1",
};

const KEYS = ["TELEGRAM_BOT_TOKEN", "NODE_ENV", "KUBERNETES_SERVICE_HOST", "TELEGRAM_CHANNEL_ID"];
const saved: Record<string, string | undefined> = {};

function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe("mayMessageTelegramUsers", () => {
  it("refuses the production token outside the cluster, NODE_ENV notwithstanding", () => {
    expect(mayMessageTelegramUsers(LAPTOP_WITH_PROD_TOKEN as any)).toBe(false);
    expect(isProductionCluster(LAPTOP_WITH_PROD_TOKEN as any)).toBe(false);
  });

  it("allows the production cluster and a known development bot", () => {
    expect(mayMessageTelegramUsers(CLUSTER as any)).toBe(true);
    expect(isProductionCluster(CLUSTER as any)).toBe(true);
    expect(mayMessageTelegramUsers(LAPTOP_WITH_DEV_BOT as any)).toBe(true);
    expect(isProductionCluster(LAPTOP_WITH_DEV_BOT as any)).toBe(false);
  });
});

describe("TelegramSimpleService outbound guard", () => {
  function service() {
    const config = { getOrThrow: () => process.env.TELEGRAM_BOT_TOKEN } as any;
    return new TelegramSimpleService(config, {} as any, {} as any);
  }

  function mockFetch() {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchMock as any;
    return fetchMock;
  }

  it("sends nothing from a laptop holding the production token", async () => {
    useEnv({ ...LAPTOP_WITH_PROD_TOKEN, TELEGRAM_CHANNEL_ID: "@oro" });
    const fetchMock = mockFetch();
    const tg = service();

    await tg.sendMessage(42, "hi");
    await tg.sendMessageWithButtons(42, "hi", [[{ text: "a", callbackData: "b" }]]);
    await tg.postToChannel("hi");
    await tg.sendRefundNotification(42, "Market", 10, "thin_pool");
    const checked = await tg.sendMessageChecked(42, "hi");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(checked.ok).toBe(false);
  });

  it("sends from the production cluster", async () => {
    useEnv(CLUSTER);
    const fetchMock = mockFetch();
    await service().sendMessage(42, "hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends from a development bot", async () => {
    useEnv(LAPTOP_WITH_DEV_BOT);
    const fetchMock = mockFetch();
    await service().sendMessage(42, "hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BotPollingService bootstrap guard", () => {
  function bot() {
    const config = {
      get: (k: string) =>
        k === "TELEGRAM_WEBHOOK_URL" ? "https://example.test/api/bot/webhook" : process.env[k],
    } as any;
    return new (BotPollingService as any)(config, {}, {}, {}, {}, {}, {}, {}, {});
  }

  it("leaves the webhook alone on a laptop holding the production token", async () => {
    useEnv(LAPTOP_WITH_PROD_TOKEN);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    await bot().onApplicationBootstrap();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers the webhook in the production cluster", async () => {
    useEnv(CLUSTER);
    const fetchMock = jest.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    global.fetch = fetchMock as any;
    await bot().onApplicationBootstrap();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/setWebhook$/);
  });
});
