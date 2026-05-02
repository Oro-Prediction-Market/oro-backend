/**
 * Database seed script — run once to populate initial test data
 * Usage: npm run seed
 */
import { DataSource } from "typeorm";
import { ConfigModule } from "@nestjs/config";
import * as dotenv from "dotenv";
import { User } from "./entities/user.entity";
import { Market, MarketStatus } from "./entities/market.entity";
import { Outcome } from "./entities/outcome.entity";

dotenv.config();

const ds = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USERNAME || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "oro_db",
  synchronize: false,
  entities: [__dirname + "/entities/*.entity.{ts,js}"],
});

async function seed() {
  await ds.initialize();
  console.log("✅ Connected to database");

  const userRepo = ds.getRepository(User);
  const marketRepo = ds.getRepository(Market);
  const outcomeRepo = ds.getRepository(Outcome);

  // ── 1. Admin user ──────────────────────────────────────────────────────────
  const existing = await userRepo.findOne({ where: { username: "admin" } });
  if (!existing) {
    const admin = userRepo.create({
      firstName: "Tara",
      lastName: "Admin",
      username: "admin",
      isAdmin: true,
    });
    await userRepo.save(admin);
    console.log("✅ Admin user created (username: admin)");
  } else {
    console.log("ℹ️  Admin user already exists");
  }

  // ── 2. Sample markets ──────────────────────────────────────────────────────
  const marketsCount = await marketRepo.count();
  if (marketsCount === 0) {
    // Market 1: Open — National vs Thimphu
    const m1 = await marketRepo.save(
      marketRepo.create({
        title: "National Team vs Thimphu Team - Gold Medal Match",
        description:
          "Predict which archery team will win the gold medal in this championship match. National Team has strong recurve archers while Thimphu Team excels in traditional archery.",
        status: MarketStatus.OPEN,
        houseEdgePct: 5,
        opensAt: new Date("2026-03-20"),
        closesAt: new Date("2026-03-25"),
      }),
    );
    await outcomeRepo.save([
      outcomeRepo.create({
        label: "National Team",
        marketId: m1.id,
        lmsrProbability: 0.5,
      }),
      outcomeRepo.create({
        label: "Thimphu Team",
        marketId: m1.id,
        lmsrProbability: 0.5,
      }),
    ]);
    console.log("✅ Market 1 created: National vs Thimphu");

    // Market 2: Open — Paro vs Punakha
    const m2 = await marketRepo.save(
      marketRepo.create({
        title: "Paro vs Punakha - Inter-District Championship",
        description:
          "Inter-district archery tournament final. Paro team has won 3 championships in the past, while Punakha team has strong accuracy in long-range shots.",
        status: MarketStatus.OPEN,
        houseEdgePct: 5,
        opensAt: new Date("2026-03-22"),
        closesAt: new Date("2026-03-28"),
      }),
    );
    await outcomeRepo.save([
      outcomeRepo.create({
        label: "Paro Team",
        marketId: m2.id,
        lmsrProbability: 0.333333,
      }),
      outcomeRepo.create({
        label: "Punakha Team",
        marketId: m2.id,
        lmsrProbability: 0.333333,
      }),
      outcomeRepo.create({
        label: "Draw",
        marketId: m2.id,
        lmsrProbability: 0.333333,
      }),
    ]);
    console.log("✅ Market 2 created: Paro vs Punakha");

    // Market 3: Upcoming — Eastern vs Western
    const m3 = await marketRepo.save(
      marketRepo.create({
        title: "Eastern vs Western Region - National Tournament",
        description:
          "Regional championship between Eastern and Western teams. Eastern region known for traditional techniques, Western region for modern recurve style.",
        status: MarketStatus.UPCOMING,
        houseEdgePct: 5,
        opensAt: new Date("2026-03-30"),
        closesAt: new Date("2026-04-05"),
      }),
    );
    await outcomeRepo.save([
      outcomeRepo.create({
        label: "Eastern Region",
        marketId: m3.id,
        lmsrProbability: 0.5,
      }),
      outcomeRepo.create({
        label: "Western Region",
        marketId: m3.id,
        lmsrProbability: 0.5,
      }),
    ]);
    console.log("✅ Market 3 created: Eastern vs Western");

    // Market 4: Open — Bumthang vs Trongsa
    const m4 = await marketRepo.save(
      marketRepo.create({
        title: "Bumthang vs Trongsa - Finals 2026",
        description:
          "Championship final between two strongest archery teams. Bumthang known for precision shooting, Trongsa for powerful long-distance shots.",
        status: MarketStatus.OPEN,
        houseEdgePct: 3,
        opensAt: new Date("2026-03-23"),
        closesAt: new Date("2026-03-27"),
      }),
    );
    await outcomeRepo.save([
      outcomeRepo.create({
        label: "Bumthang Team",
        marketId: m4.id,
        lmsrProbability: 0.5,
      }),
      outcomeRepo.create({
        label: "Trongsa Team",
        marketId: m4.id,
        lmsrProbability: 0.5,
      }),
    ]);
    console.log("✅ Market 4 created: Bumthang vs Trongsa");
  } else {
    console.log(`ℹ️  ${marketsCount} markets already exist — skipping seed`);
  }

  await ds.destroy();
  console.log(
    "\n🎉 Seed complete! Open http://localhost:3000/docs to explore the API.",
  );
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
