import { classifyDkStatus } from "../payment/dk-status.util";

describe("classifyDkStatus", () => {
  it.each(["SUCCESS", "Successful", "TXN SUCCESSFUL"])(
    "reads %p as success",
    (s) => expect(classifyDkStatus(s)).toBe("success"),
  );

  // The whole point of the helper: these all contain "SUCCESS" as a substring.
  it.each([
    "UNSUCCESSFUL",
    "Transaction Unsuccessful",
    "not successful",
    "FAILED",
    "REJECTED",
    "Declined by beneficiary bank",
    "REVERSED",
    "CANCELLED",
  ])("reads %p as failed", (s) => expect(classifyDkStatus(s)).toBe("failed"));

  it.each(["PENDING", "IN PROGRESS", "", null, undefined, "something new"])(
    "reads %p as pending",
    (s) => expect(classifyDkStatus(s)).toBe("pending"),
  );
});
