import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class BhutanAppNotificationService {
  private readonly logger = new Logger(BhutanAppNotificationService.name);

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
    const authToken = this.config.get<string>(
      "BHUTANAPP_NOTIFICATION_AUTH_TOKEN",
    );

    if (!serviceUrl || !authToken) {
      this.logger.warn(
        "BhutanApp notification not configured (missing URL or token)",
      );
      return false;
    }

    try {
      const baseUrl = serviceUrl.replace(/\/+$/, "");
      const endpoint = `${baseUrl}/notifications/send-notifications`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          target: "specific",
          userIds: [externalUserId],
          categoryName: "system_critical_notifications",
          title,
          body,
          priorityLevel: 1,
          deliveryMethods: ["push"],
        }),
        signal: AbortSignal.timeout(10_000),
      });

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
}
