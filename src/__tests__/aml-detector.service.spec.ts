import { AmlDetectorService } from "../aml/aml-detector.service";
import { AmlAlertType } from "../aml/entities/aml-alert.entity";

/**
 * Every amount-based check used to filter on currency = 'BTN', so nothing our
 * USDT players did was watched. Each now runs once per ledger with that
 * ledger's own thresholds.
 */

const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2026-10-07T00:00:00Z");

/** Which check a query belongs to, read from SQL that only it contains. */
function checkOf(sql: string): string {
  if (sql.includes("suspicious AS")) return "rapid";
  if (sql.includes("user_deposits AS")) return "ratio";
  if (sql.includes("daily AS")) return "nearLimit";
  return "frequency";
}

function build(
  opts: {
    env?: Record<string, string>;
    rows?: (check: string, currency: string | undefined) => any[];
  } = {},
) {
  const calls: { check: string; sql: string; params: any[] }[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[]) => {
      const check = checkOf(sql);
      calls.push({ check, sql, params });
      return opts.rows?.(check, params[2]) ?? [];
    }),
  };
  const config: any = { get: (k: string) => opts.env?.[k] };
  return { service: new AmlDetectorService(ds, config), calls };
}

describe("AmlDetectorService — USDT is watched", () => {
  it("runs every amount check against both ledgers, never hard-coding BTN", async () => {
    const { service, calls } = build();
    await service.runScan(FROM, TO);

    for (const check of ["rapid", "ratio", "nearLimit"]) {
      const currencies = calls
        .filter((c) => c.check === check)
        .map((c) => c.params[2])
        .sort();
      expect({ check, currencies }).toEqual({ check, currencies: ["BTN", "USDT"] });
    }
    for (const c of calls) expect(c.sql).not.toContain("'BTN'");
  });

  it("keeps the original BTN thresholds", async () => {
    const { service, calls } = build();
    await service.runScan(FROM, TO);
    const btn = (check: string) =>
      calls.find((c) => c.check === check && c.params[2] === "BTN")!.params[3];

    expect(btn("rapid")).toBe(3000);
    expect(btn("ratio")).toBe(20000);
    expect(btn("nearLimit")).toBe(14000);
  });

  it("uses USDT-sized thresholds, not ngultrum figures read as dollars", async () => {
    const { service, calls } = build();
    await service.runScan(FROM, TO);
    const usdt = (check: string) =>
      calls.find((c) => c.check === check && c.params[2] === "USDT")!.params[3];

    expect(usdt("rapid")).toBe(35);
    expect(usdt("ratio")).toBe(235);
    // 90% of the default USDT_MAX_DEPOSIT of 1000.
    expect(usdt("nearLimit")).toBe(900);
  });

  it("lets each USDT threshold be overridden, and follows USDT_MAX_DEPOSIT", async () => {
    const { service } = build({
      env: {
        AML_USDT_RAPID_MIN_DEPOSIT: "50",
        AML_USDT_LOW_RATIO_MIN_DEPOSITS: "500",
        USDT_MAX_DEPOSIT: "2000",
      },
    });
    const usdt = service.ledgers().find((l) => l.currency === "USDT")!;
    expect(usdt.rapidMinDeposit).toBe(50);
    expect(usdt.lowRatioMinDeposits).toBe(500);
    expect(usdt.nearLimitDaily).toBe(1800);
  });

  it("ignores a nonsense override rather than switching a check off", async () => {
    const { service } = build({ env: { AML_USDT_RAPID_MIN_DEPOSIT: "abc" } });
    expect(
      service.ledgers().find((l) => l.currency === "USDT")!.rapidMinDeposit,
    ).toBe(35);
  });

  // A BTN bet must not excuse a USDT deposit→withdrawal round trip.
  it("only counts bets in the same currency as clearing a rapid round trip", async () => {
    const { service, calls } = build();
    await service.runScan(FROM, TO);
    const rapid = calls.find((c) => c.check === "rapid")!.sql;
    expect(rapid).toMatch(/b\.currency\s*=\s*\$3/);
  });

  it("writes a USDT alert in dollars and tags it with its currency", async () => {
    const { service } = build({
      rows: (check, currency) =>
        check === "rapid" && currency === "USDT"
          ? [
              {
                userId: "u1",
                dkCid: null,
                deposit_id: "t1",
                deposit_amount: "500",
                deposit_time: FROM,
                wd_total: "480",
                wd_time: FROM,
                gap_min: "12",
              },
            ]
          : [],
    });
    const [alert] = await service.runScan(FROM, TO);

    expect(alert.alertType).toBe(AmlAlertType.RAPID_DEPOSIT_WITHDRAWAL);
    expect(alert.description).toContain("Deposited 500 USDT");
    expect(alert.description).toContain("withdrew 480 USDT");
    expect(alert.description).not.toContain("Nu");
    expect(alert.metadata.currency).toBe("USDT");
  });

  // Counts, not amounts — but a BTN and a USDT count must not be added up.
  it("groups transaction frequency by currency", async () => {
    const { service, calls } = build({
      rows: (check) =>
        check === "frequency"
          ? [{ userId: "u1", dkCid: null, currency: "USDT", tx_count: 16, week_start: FROM }]
          : [],
    });
    const alerts = await service.runScan(FROM, TO);

    const freq = calls.filter((c) => c.check === "frequency");
    expect(freq).toHaveLength(1);
    expect(freq[0].sql).toMatch(/GROUP BY[^]*t\.currency/);
    expect(alerts[0].description).toContain("16 USDT deposit/withdrawal");
    expect(alerts[0].metadata.currency).toBe("USDT");
  });
});
