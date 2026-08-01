import { DataSource } from "typeorm";
import * as dotenv from "dotenv";

dotenv.config();

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5433,
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
  // NEVER true here: this DataSource backs the typeorm CLI, so a stray
  // `synchronize` would rewrite the schema of whatever DB the env points at.
  synchronize: false,
  migrationsRun: false,
  logging: true,
  extra: {
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  },
  // Glob, not a hand-maintained list: this list had drifted behind app.module
  // (Reconciliation + the AML entities were missing), and `migration:generate`
  // emits DROP TABLE for any table whose entity it cannot see.
  entities: [__dirname + "/**/*.entity{.ts,.js}"],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  subscribers: [],
});
