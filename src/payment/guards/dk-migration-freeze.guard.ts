import {
  CanActivate,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DkMigrationFreezeWindow,
  describeDkMigrationFreeze,
  isDkMigrationFreezeActive,
  resolveDkMigrationFreezeWindow,
} from "../dk-migration-window";

/**
 * Closes the DK Bank cash rail for the migration cutover.
 *
 * Both wallets hide their Top Up and Cash Out buttons for the same window, but
 * that is a courtesy, not the control: a device clock can be wrong, a tab left
 * open since the afternoon still has live handlers, and the endpoints answer
 * anyone holding a JWT. This is the check that actually holds.
 *
 * The window is resolved once, at boot, so a bad override is loud in the
 * startup log rather than at 11 PM.
 */
@Injectable()
export class DkMigrationFreezeGuard implements CanActivate {
  private readonly logger = new Logger(DkMigrationFreezeGuard.name);
  private readonly window: DkMigrationFreezeWindow | null;

  constructor() {
    const { window, warning } = resolveDkMigrationFreezeWindow();
    if (warning) this.logger.error(warning);
    this.window = window;

    if (window) {
      this.logger.log(
        `DK Bank deposits and withdrawals are frozen ${describeDkMigrationFreeze(window)}`,
      );
    } else {
      this.logger.log("DK Bank migration freeze is switched off");
    }
  }

  canActivate(): boolean {
    if (!isDkMigrationFreezeActive(this.window, new Date())) return true;

    // 503 rather than 403: this is temporary and the caller did nothing wrong.
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: "DK_MIGRATION_FREEZE",
      message:
        `Top ups and cash outs are paused while DK Bank completes a system ` +
        `migration (${describeDkMigrationFreeze(this.window!)}). Your balance ` +
        `and open predictions are unaffected — please try again after the migration.`,
      windowStart: this.window!.start.toISOString(),
      windowEnd: this.window!.end.toISOString(),
    });
  }
}
