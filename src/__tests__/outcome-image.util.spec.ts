import {
  isDataUri,
  dataUriTag,
  outcomeImageRef,
  decodeDataUri,
  withOutcomeImageRefs,
} from "../markets/outcome-image.util";

// A real 1x1 PNG, so decoding is exercised against actual bytes.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = `data:image/png;base64,${PNG_B64}`;

describe("decodeDataUri", () => {
  it("decodes an image data URI to bytes", () => {
    const out = decodeDataUri(PNG);
    expect(out).not.toBeNull();
    expect(out!.mime).toBe("image/png");
    // PNG magic number — proves we returned the real bytes, not the base64.
    expect(out!.body.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("refuses anything that is not an image", () => {
    // The route is public and keyed only by outcome id, so it must never
    // become a way to read back arbitrary stored text with a content type the
    // writer chose.
    expect(decodeDataUri("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(
      decodeDataUri("data:application/javascript;base64,YWxlcnQoMSk="),
    ).toBeNull();
  });

  it("returns null for things that are not data URIs at all", () => {
    expect(decodeDataUri("https://flagcdn.com/w320/fr.png")).toBeNull();
    expect(decodeDataUri("")).toBeNull();
    expect(decodeDataUri("data:image/png,notbase64")).toBeNull();
  });

  it("returns null for an empty payload rather than a zero-byte image", () => {
    expect(decodeDataUri("data:image/png;base64,")).toBeNull();
  });
});

describe("isDataUri", () => {
  it("separates inlined images from real URLs", () => {
    expect(isDataUri(PNG)).toBe(true);
    expect(isDataUri("https://flagcdn.com/w320/fr.png")).toBe(false);
    expect(isDataUri(null)).toBe(false);
    expect(isDataUri(undefined)).toBe(false);
  });
});

describe("outcomeImageRef", () => {
  it("fingerprints the image so replacing it changes the URL", () => {
    // The reference is served with a one-year immutable cache header. Without
    // this, a replaced crest would stay pinned on every device that had
    // already seen the old one.
    const a = outcomeImageRef("o1", PNG);
    const b = outcomeImageRef("o1", "data:image/png;base64,AAAA");
    expect(a).not.toEqual(b);
    expect(a).toContain("o1");
  });

  it("is stable for the same image", () => {
    expect(outcomeImageRef("o1", PNG)).toEqual(outcomeImageRef("o1", PNG));
    expect(dataUriTag(PNG)).toEqual(dataUriTag(PNG));
  });

  it("is origin-relative, for the client to resolve", () => {
    // The API and the apps are on different hosts and this process cannot
    // reliably know its own public origin — emitting an absolute http:// URL
    // onto an https page would have the browser block it.
    const ref = outcomeImageRef("o1", PNG);
    expect(ref.startsWith("/")).toBe(true);
    expect(ref).not.toMatch(/^https?:/);
  });
});

describe("withOutcomeImageRefs", () => {
  const market = (outcomes: { id: string; imageUrl: string | null }[]) => ({
    id: "m1",
    outcomes,
  });

  it("replaces inlined images and leaves real URLs alone", () => {
    const [out] = withOutcomeImageRefs([
      market([
        { id: "a", imageUrl: PNG },
        { id: "b", imageUrl: "https://flagcdn.com/w320/fr.png" },
        { id: "c", imageUrl: null },
      ]),
    ]);
    expect(out.outcomes[0].imageUrl).toContain("outcome-image/a");
    expect(out.outcomes[1].imageUrl).toBe("https://flagcdn.com/w320/fr.png");
    expect(out.outcomes[2].imageUrl).toBeNull();
  });

  it("does not mutate the markets it was given", () => {
    // These come straight off the Redis cache; rewriting in place would leave
    // the cached copy in whatever shape the last caller wanted.
    const input = market([{ id: "a", imageUrl: PNG }]);
    withOutcomeImageRefs([input]);
    expect(input.outcomes[0].imageUrl).toBe(PNG);
  });

  it("returns untouched markets by identity when nothing is inlined", () => {
    const input = market([{ id: "a", imageUrl: "https://x/y.png" }]);
    expect(withOutcomeImageRefs([input])[0]).toBe(input);
  });

  it("survives markets with no outcomes", () => {
    expect(() =>
      withOutcomeImageRefs([{ id: "m", outcomes: null }, { id: "m2" } as any]),
    ).not.toThrow();
  });
});
