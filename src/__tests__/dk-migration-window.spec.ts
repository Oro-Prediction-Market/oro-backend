import {
  DK_MIGRATION_FREEZE_DEFAULT_END,
  DK_MIGRATION_FREEZE_DEFAULT_START,
  describeDkMigrationFreeze,
  isDkMigrationFreezeActive,
  resolveDkMigrationFreezeWindow,
} from "../payment/dk-migration-window";

const DEFAULTS = {
  start: new Date(DK_MIGRATION_FREEZE_DEFAULT_START),
  end: new Date(DK_MIGRATION_FREEZE_DEFAULT_END),
};

/**
 * Instants relative to whatever the configured end happens to be.
 *
 * The end date is policy — it moved once already, when DK's migration went
 * wrong and the rail had to stay shut — and every test that hardcoded
 * "20 Sep 08:00" broke the moment it did. What these tests actually care
 * about is the shape of the window (half-open, one-off, instant-based), not
 * the date, so they derive from the constant and survive the next extension.
 */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const fromEnd = (ms: number) => new Date(DEFAULTS.end.getTime() + ms);

describe("DK migration freeze window", () => {
  describe("resolveDkMigrationFreezeWindow", () => {
    it("uses the cutover dates when nothing is configured", () => {
      const { window, warning } = resolveDkMigrationFreezeWindow({});
      expect(warning).toBeNull();
      expect(window).toEqual(DEFAULTS);
    });

    it("takes ISO overrides for both ends", () => {
      const { window, warning } = resolveDkMigrationFreezeWindow({
        DK_MIGRATION_FREEZE_START: "2026-09-19T22:00:00+06:00",
        DK_MIGRATION_FREEZE_END: "2026-09-20T11:00:00+06:00",
      });
      expect(warning).toBeNull();
      expect(window!.start.toISOString()).toBe("2026-09-19T16:00:00.000Z");
      expect(window!.end.toISOString()).toBe("2026-09-20T05:00:00.000Z");
    });

    it("lets one end be overridden while the other keeps its default", () => {
      const { window } = resolveDkMigrationFreezeWindow({
        DK_MIGRATION_FREEZE_END: "2026-09-20T11:00:00+06:00",
      });
      expect(window!.start).toEqual(DEFAULTS.start);
      expect(window!.end.toISOString()).toBe("2026-09-20T05:00:00.000Z");
    });

    it("switches the freeze off only on an explicit `off`", () => {
      expect(
        resolveDkMigrationFreezeWindow({ DK_MIGRATION_FREEZE_START: "off" })
          .window,
      ).toBeNull();
      expect(
        resolveDkMigrationFreezeWindow({ DK_MIGRATION_FREEZE_END: "OFF " })
          .window,
      ).toBeNull();
    });

    // The failure that would actually cost money: someone copies .env.example,
    // the keys land blank, and the rail quietly reopens mid-migration.
    it("keeps the freeze on when an override is blank", () => {
      const { window, warning } = resolveDkMigrationFreezeWindow({
        DK_MIGRATION_FREEZE_START: "",
        DK_MIGRATION_FREEZE_END: "   ",
      });
      expect(window).toEqual(DEFAULTS);
      expect(warning).toBeNull();
    });

    it("refuses an unparseable override and says so", () => {
      const { window, warning } = resolveDkMigrationFreezeWindow({
        DK_MIGRATION_FREEZE_START: "19 Sept 11pm",
      });
      expect(window).toEqual(DEFAULTS);
      expect(warning).toContain("DK_MIGRATION_FREEZE_START");
    });

    it("refuses a window that ends before it starts", () => {
      const { window, warning } = resolveDkMigrationFreezeWindow({
        DK_MIGRATION_FREEZE_START: "2026-09-20T08:00:00+06:00",
        DK_MIGRATION_FREEZE_END: "2026-09-19T23:00:00+06:00",
      });
      expect(window).toEqual(DEFAULTS);
      expect(warning).toContain("not before end");
    });
  });

  describe("isDkMigrationFreezeActive", () => {
    const at = (iso: string) => isDkMigrationFreezeActive(DEFAULTS, new Date(iso));

    it("is open right up to the start instant", () => {
      expect(at("2026-09-19T22:59:59+06:00")).toBe(false);
    });

    it("closes on the start instant and stays closed through the window", () => {
      expect(at("2026-09-19T23:00:00+06:00")).toBe(true);
      expect(at("2026-09-20T03:30:00+06:00")).toBe(true);
      // The morning the rail used to reopen — now still inside the window,
      // which is the whole point of the extension.
      expect(at("2026-09-20T08:00:00+06:00")).toBe(true);
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(-1))).toBe(true);
    });

    it("reopens exactly on the end instant, not a tick later", () => {
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(0))).toBe(false);
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(1))).toBe(false);
    });

    // The window is two fixed instants, not a nightly 11pm-8am schedule.
    it("never fires again on later nights", () => {
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(DAY))).toBe(false);
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(30 * DAY))).toBe(false);
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(365 * DAY))).toBe(false);
    });

    it("was not already active before the cutover", () => {
      expect(at("2026-09-18T23:30:00+06:00")).toBe(false);
      expect(at("2026-09-19T08:00:00+06:00")).toBe(false);
    });

    it("is never active when the freeze is switched off", () => {
      expect(
        isDkMigrationFreezeActive(null, new Date("2026-09-20T02:00:00+06:00")),
      ).toBe(false);
    });

    // A phone in Kolkata reads the same instant as a server in Thimphu.
    it("keys off the instant, not the local wall clock", () => {
      // 23:30 BTT on the cutover night, written as UTC.
      expect(isDkMigrationFreezeActive(DEFAULTS, new Date("2026-09-19T17:30:00Z"))).toBe(
        true,
      );
      expect(isDkMigrationFreezeActive(DEFAULTS, fromEnd(30 * MINUTE))).toBe(false);
    });
  });

  describe("describeDkMigrationFreeze", () => {
    // A fixed window of its own, not DEFAULTS: this tests the formatter, and
    // it must not fail every time the freeze is extended.
    it("renders the window in Bhutan time whatever the process TZ", () => {
      const text = describeDkMigrationFreeze({
        start: new Date("2026-09-19T23:00:00+06:00"),
        end: new Date("2026-09-20T08:00:00+06:00"),
      });
      expect(text).toContain("19 Sep");
      expect(text).toContain("20 Sep");
      expect(text).toContain("11:00 pm");
      expect(text).toContain("8:00 am");
      expect(text).toContain("BTT");
    });
  });
});
