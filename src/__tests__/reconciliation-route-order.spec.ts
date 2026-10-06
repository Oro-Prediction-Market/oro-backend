import { ReconciliationController } from "../reconciliation/reconciliation.controller";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";

/**
 * Nest matches routes in declaration order. With `GET :id` declared before
 * `GET segregation`, "segregation" was read as a reconciliation id and the
 * endpoint returned a 500 (invalid uuid) — it had never been reachable.
 */
describe("ReconciliationController route order", () => {
  it("declares every literal GET route before GET :id", () => {
    const proto = ReconciliationController.prototype as any;
    const gets = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== "constructor")
      .filter((k) => Reflect.getMetadata(METHOD_METADATA, proto[k]) === RequestMethod.GET)
      .map((k) => Reflect.getMetadata(PATH_METADATA, proto[k]) as string);

    const idAt = gets.indexOf(":id");
    expect(idAt).toBeGreaterThan(-1);
    for (const literal of gets.filter((p) => !p.startsWith(":") && p !== "/")) {
      expect({ route: literal, before: gets.indexOf(literal) < idAt }).toEqual({
        route: literal,
        before: true,
      });
    }
    expect(gets).toContain("segregation");
  });
});
