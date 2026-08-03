import { maskEmail, maskPhone } from "../shared/utils/redact.util";

describe("redact util — logs must never carry full PII", () => {
  describe("maskPhone", () => {
    it("keeps only the last 4 digits", () => {
      expect(maskPhone("+97517123456")).toBe("+*******3456");
      expect(maskPhone("17123456")).toBe("****3456");
    });
    it("does not leak short or empty values", () => {
      expect(maskPhone("123")).toBe("****");
      expect(maskPhone("")).toBe("****");
      expect(maskPhone(null)).toBe("****");
      expect(maskPhone(undefined)).toBe("****");
    });
    it("never contains the full original number", () => {
      const full = "97517998877";
      expect(maskPhone(full)).not.toContain(full);
    });
  });

  describe("maskEmail", () => {
    it("keeps first initial and the TLD only", () => {
      expect(maskEmail("alice@example.com")).toBe("a***@***.com");
      expect(maskEmail("bob@oro.bt")).toBe("b***@***.bt");
    });
    it("does not leak malformed or empty values", () => {
      expect(maskEmail("not-an-email")).toBe("****");
      expect(maskEmail("@nope.com")).toBe("****");
      expect(maskEmail("trailing@")).toBe("****");
      expect(maskEmail("")).toBe("****");
      expect(maskEmail(null)).toBe("****");
    });
    it("never contains the local part beyond the first char", () => {
      expect(maskEmail("secretuser@example.com")).not.toContain("secretuser");
    });
  });
});
