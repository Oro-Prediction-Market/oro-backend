import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Refresh the access token this many ms before it actually expires. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

@Injectable()
export class BhutanAppNotificationService {
  private readonly logger = new Logger(BhutanAppNotificationService.name);

  private cachedToken: string | null = null;
  private cachedTokenExpiresAt = 0;
  /** In-flight login, shared so concurrent sends trigger only one login call. */
  private loginInFlight: Promise<string | null> | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Send a push notification to a user via BhutanApp notification service.
   * @param externalUserId - The user's BhutanApp external user ID
   * @param title - Notification title
   * @param body - Notification body text
   */
  async sendNotification(
    externalUserId: string,
    title: string,
    body: string,
  ): Promise<boolean> {
    const serviceUrl = this.config.get<string>(
      "BHUTANAPP_NOTIFICATION_SERVICE_URL",
    );

    if (!serviceUrl) {
      this.logger.warn("BhutanApp notification not configured (missing URL)");
      return false;
    }

    let authToken = await this.getAuthToken();
    if (!authToken) {
      this.logger.warn(
        "BhutanApp notification not configured (no credentials or token)",
      );
      return false;
    }

    const baseUrl = serviceUrl.replace(/\/+$/, "");
    const endpoint = `${baseUrl}/notifications/send-notifications`;
    const payload = JSON.stringify({
      target: "specific",
      userIds: [externalUserId],
      categoryName: "system_critical_notifications",
      title,
      body,
      priorityLevel: 1,
      deliveryMethods: ["push"],
    });

    try {
      let response = await this.post(endpoint, payload, authToken);

      // A cached token can be revoked server-side before its stated expiry.
      // Re-login once and retry before giving up.
      if (response.status === 401) {
        this.invalidateToken();
        authToken = await this.getAuthToken();
        if (authToken) {
          response = await this.post(endpoint, payload, authToken);
        }
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.warn(
          `BhutanApp notification failed [${response.status}]: ${text}`,
        );
        return false;
      }

      this.logger.log(
        `BhutanApp notification sent to user ${externalUserId}: "${title}"`,
      );
      return true;
    } catch (err: any) {
      this.logger.error(
        `BhutanApp notification error: ${err.message}`,
        err.stack,
      );
      return false;
    }
  }

  private post(
    endpoint: string,
    body: string,
    authToken: string,
  ): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  }

  private invalidateToken(): void {
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
  }

  /**
   * Resolve a usable access token: the cached one if still fresh, otherwise a
   * newly minted one from the auth service. Falls back to a statically
   * configured token when service credentials are not set.
   */
  private async getAuthToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.cachedTokenExpiresAt) {
      return this.cachedToken;
    }

    const username = this.config.get<string>("BHUTANAPP_SERVICE_USERNAME");
    const password = this.config.get<string>("BHUTANAPP_SERVICE_PASSWORD");

    if (!username || !password) {
      return (
        this.config.get<string>("BHUTANAPP_NOTIFICATION_AUTH_TOKEN") ?? null
      );
    }

    if (!this.loginInFlight) {
      this.loginInFlight = this.login(username, password).finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async login(
    username: string,
    password: string,
  ): Promise<string | null> {
    const authUrl = this.resolveAuthUrl();
    if (!authUrl) {
      this.logger.warn(
        "BhutanApp auth URL not configured (BHUTANAPP_AUTH_SERVICE_URL)",
      );
      return null;
    }

    try {
      const response = await fetch(`${authUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.error(
          `BhutanApp login failed [${response.status}]: ${text}`,
        );
        return null;
      }

      const data: any = await response.json();
      const accessToken: string | undefined = data?.token?.accessToken;
      if (!accessToken) {
        this.logger.error("BhutanApp login returned no access token");
        return null;
      }

      const expiresInSec = Number(data?.token?.expiresIn) || 3600;
      this.cachedToken = accessToken;
      this.cachedTokenExpiresAt =
        Date.now() + Math.max(expiresInSec * 1000 - TOKEN_REFRESH_SKEW_MS, 0);

      this.logger.log(
        `BhutanApp service token refreshed (valid ${expiresInSec}s)`,
      );
      return accessToken;
    } catch (err: any) {
      this.logger.error(`BhutanApp login error: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * Auth service base URL. Derived from the notification service URL when not
   * set explicitly — both live under the same `/svc/<name>` gateway prefix.
   */
  private resolveAuthUrl(): string | null {
    const explicit = this.config.get<string>("BHUTANAPP_AUTH_SERVICE_URL");
    if (explicit) return explicit.replace(/\/+$/, "");

    const notificationUrl = this.config
      .get<string>("BHUTANAPP_NOTIFICATION_SERVICE_URL")
      ?.replace(/\/+$/, "");
    if (!notificationUrl) return null;

    return notificationUrl.replace(/\/notification$/, "/auth");
  }
}
