import { MarketsController } from "../markets/markets.controller";
import { NotFoundException } from "@nestjs/common";

/**
 * The outcome-image endpoint has to be loadable from a different origin.
 *
 * The apps run on oro.fun and the API on api.oro.fun, and helmet sets
 * `Cross-Origin-Resource-Policy: same-origin` on every response by default.
 * An <img> is a no-cors load, so the browser drops the response before it
 * reaches the element — no console error worth noticing, no failed request in
 * the network tab, just a crest that quietly falls back to a letter.
 *
 * It is invisible to every check that is not a browser: curl, fetch() and
 * supertest all report a perfectly good PNG. That is what makes it worth a
 * test rather than a manual look.
 */
describe("MarketsController.outcomeImage", () => {
  const image = { mime: "image/png", body: Buffer.from([1, 2, 3]) };

  function build(found: typeof image | null = image) {
    const headers: Record<string, unknown> = {};
    const res = {
      setHeader: jest.fn((k: string, v: unknown) => {
        headers[k] = v;
      }),
      end: jest.fn(),
    };
    const marketsService = {
      getOutcomeImage: jest.fn().mockResolvedValue(found),
    };
    const controller = new MarketsController(
      marketsService as any,
      {} as any,
      {} as any,
    );
    return { controller, res, headers, marketsService };
  }

  it("marks the image as loadable cross-origin", async () => {
    const { controller, res, headers } = build();

    await controller.outcomeImage("out-1", res as any);

    expect(headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
    expect(res.end).toHaveBeenCalledWith(image.body);
  });

  it("serves the stored bytes with their own content type", async () => {
    const { controller, res, headers } = build();

    await controller.outcomeImage("out-1", res as any);

    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Content-Length"]).toBe(3);
  });

  /**
   * The URL carries a fingerprint of the image, so a year is safe: replacing
   * an image changes its URL rather than leaving a stale copy pinned on every
   * device that ever saw it.
   */
  it("lets the browser keep the image for a year", async () => {
    const { controller, res, headers } = build();

    await controller.outcomeImage("out-1", res as any);

    expect(headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("404s an outcome with no stored image rather than sending an empty body", async () => {
    const { controller, res } = build(null);

    await expect(controller.outcomeImage("out-1", res as any)).rejects.toThrow(
      NotFoundException,
    );
    expect(res.end).not.toHaveBeenCalled();
  });
});
