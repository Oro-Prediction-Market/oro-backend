import { BhutanAppNotificationService } from "../shared/services/bhutanapp-notification.service";

const NOTIFY_URL = "https://svc.test/svc/notification";

function makeConfig(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as any;
}

function loginOk(token = "tok-1", expiresIn = 3600) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ token: { accessToken: token, expiresIn } }),
  };
}

function sendOk() {
  return { ok: true, status: 200, text: async () => "" };
}

function unauthorized() {
  return {
    ok: false,
    status: 401,
    text: async () => '{"message":"Unauthorized","statusCode":401}',
  };
}

function urlOf(call: any[]): string {
  return call[0] as string;
}

function authHeaderOf(call: any[]): string | undefined {
  return call[1]?.headers?.Authorization;
}

describe("BhutanAppNotificationService", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const credentialedConfig = makeConfig({
    BHUTANAPP_NOTIFICATION_SERVICE_URL: NOTIFY_URL,
    BHUTANAPP_SERVICE_USERNAME: "user",
    BHUTANAPP_SERVICE_PASSWORD: "pass",
  });

  it("logs in and sends with the freshly minted token", async () => {
    fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(sendOk());
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(true);

    expect(urlOf(fetchMock.mock.calls[0])).toBe(
      "https://svc.test/svc/auth/auth/login",
    );
    expect(urlOf(fetchMock.mock.calls[1])).toBe(
      `${NOTIFY_URL}/notifications/send-notifications`,
    );
    expect(authHeaderOf(fetchMock.mock.calls[1])).toBe("Bearer tok-1");
  });

  it("reuses the cached token across sends", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValue(sendOk() as any);
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await svc.sendNotification("ext-1", "T", "B");
    await svc.sendNotification("ext-2", "T", "B");

    const logins = fetchMock.mock.calls.filter((c) =>
      urlOf(c).includes("/auth/login"),
    );
    expect(logins).toHaveLength(1);
  });

  it("re-logs in once the cached token has aged past its lifetime", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("tok-1", 3600))
      .mockResolvedValueOnce(sendOk())
      .mockResolvedValueOnce(loginOk("tok-2", 3600))
      .mockResolvedValueOnce(sendOk());
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await svc.sendNotification("ext-1", "T", "B");
    // Past the 3600s lifetime minus the 60s refresh skew.
    (Date.now as jest.Mock).mockReturnValue(1_000_000 + 3_600_000);
    await svc.sendNotification("ext-2", "T", "B");

    expect(authHeaderOf(fetchMock.mock.calls[3])).toBe("Bearer tok-2");
  });

  it("refreshes and retries once when a send is rejected with 401", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("stale"))
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(loginOk("fresh"))
      .mockResolvedValueOnce(sendOk());
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(true);
    expect(authHeaderOf(fetchMock.mock.calls[1])).toBe("Bearer stale");
    expect(authHeaderOf(fetchMock.mock.calls[3])).toBe("Bearer fresh");
  });

  it("does not retry more than once on repeated 401s", async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk("a"))
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(loginOk("b"))
      .mockResolvedValueOnce(unauthorized());
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("issues a single login for concurrent sends", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/auth/login") ? loginOk() : sendOk(),
    );
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await Promise.all([
      svc.sendNotification("ext-1", "T", "B"),
      svc.sendNotification("ext-2", "T", "B"),
      svc.sendNotification("ext-3", "T", "B"),
    ]);

    const logins = fetchMock.mock.calls.filter((c) =>
      urlOf(c).includes("/auth/login"),
    );
    expect(logins).toHaveLength(1);
  });

  it("falls back to the static token when credentials are unset", async () => {
    fetchMock.mockResolvedValueOnce(sendOk());
    const svc = new BhutanAppNotificationService(
      makeConfig({
        BHUTANAPP_NOTIFICATION_SERVICE_URL: NOTIFY_URL,
        BHUTANAPP_NOTIFICATION_AUTH_TOKEN: "legacy",
      }),
    );

    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer legacy");
  });

  it("prefers an explicit auth service URL over the derived one", async () => {
    fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(sendOk());
    const svc = new BhutanAppNotificationService(
      makeConfig({
        BHUTANAPP_NOTIFICATION_SERVICE_URL: NOTIFY_URL,
        BHUTANAPP_AUTH_SERVICE_URL: "https://auth.test/svc/auth/",
        BHUTANAPP_SERVICE_USERNAME: "user",
        BHUTANAPP_SERVICE_PASSWORD: "pass",
      }),
    );

    await svc.sendNotification("ext-1", "T", "B");
    expect(urlOf(fetchMock.mock.calls[0])).toBe(
      "https://auth.test/svc/auth/auth/login",
    );
  });

  it("returns false without calling out when the URL is missing", async () => {
    const svc = new BhutanAppNotificationService(makeConfig({}));
    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when login fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "bad creds",
    });
    const svc = new BhutanAppNotificationService(credentialedConfig);

    await expect(svc.sendNotification("ext-1", "T", "B")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
