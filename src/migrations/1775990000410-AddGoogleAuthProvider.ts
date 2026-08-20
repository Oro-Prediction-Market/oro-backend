import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Google Sign-In as an auth provider.
 *
 * Google verifies the address for us, which removes three things the
 * email/password path needs: a verification flow, a reset flow, and a stored
 * password. It says nothing about **who owns** that address, so KYC still
 * gates deposits exactly as before.
 *
 * No new columns. `auth_methods` is already unique on `(provider, providerId)`,
 * so storing Google's `sub` there gives one-account-per-Google-account free.
 */
export class AddGoogleAuthProvider1775990000410 implements MigrationInterface {
  name = "AddGoogleAuthProvider1775990000410";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "auth_methods_provider_enum" ADD VALUE IF NOT EXISTS 'google'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot remove an enum value. Harmless: nothing authenticates
    // with 'google' once the code that issues it is gone.
  }
}
