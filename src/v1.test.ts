import { describe, expect, it } from "vitest";
import { parseSourceRequest, toConvertDocumentResponse, wantsJson } from "./v1.mjs";

const CONVERSION = {
  markdown: "# Doc\n\nParagraph.",
  chunks: [{ text: "Doc" }, { text: "Paragraph." }],
  format: "pdf",
  inputName: "report.pdf",
  timings: { convertMs: 1200, chunkMs: 1500 },
};

describe("parseSourceRequest", () => {
  it("reads a base64 file source", () => {
    const out = parseSourceRequest({
      sources: [
        { kind: "file", filename: "a.pdf", base64_string: Buffer.from("x").toString("base64") },
      ],
      target: { kind: "inbody" },
    });
    expect(out.kind).toBe("file");
    expect(out.filename).toBe("a.pdf");
    expect(out.bytes?.toString()).toBe("x");
  });

  it("reads an http source with its headers", () => {
    const out = parseSourceRequest({
      sources: [
        {
          kind: "http",
          url: "https://example.test/a.pdf",
          headers: { Authorization: "Bearer t" },
        },
      ],
    });
    expect(out.kind).toBe("http");
    expect(out.url).toBe("https://example.test/a.pdf");
    expect(out.headers).toEqual({ Authorization: "Bearer t" });
    // The filename comes from the URL, because the extension picks the format.
    expect(out.filename).toBe("a.pdf");
  });

  it("rejects a request with no sources", () => {
    expect(() => parseSourceRequest({ sources: [] })).toThrow(/sources/i);
    expect(() => parseSourceRequest({})).toThrow(/sources/i);
  });

  // The service converts one document per request; docling-serve's own
  // max_sources_per_request is 3, but this one cannot batch at all.
  it("rejects more than one source rather than silently dropping the rest", () => {
    expect(() =>
      parseSourceRequest({
        sources: [
          { kind: "file", filename: "a.pdf", base64_string: "eA==" },
          { kind: "file", filename: "b.pdf", base64_string: "eA==" },
        ],
      }),
    ).toThrow(/one source/i);
  });

  it("rejects an http source whose URL has no usable filename", () => {
    expect(() =>
      parseSourceRequest({ sources: [{ kind: "http", url: "https://example.test/download" }] }),
    ).toThrow(/filename/i);
  });

  it("rejects an unknown source kind", () => {
    expect(() => parseSourceRequest({ sources: [{ kind: "s3", url: "s3://b/k" }] })).toThrow(
      /kind/i,
    );
  });

  // Only `inbody` is possible here: the service returns the document on the
  // same connection and has nowhere to put it.
  it("rejects a target other than inbody", () => {
    expect(() =>
      parseSourceRequest({
        sources: [{ kind: "file", filename: "a.pdf", base64_string: "eA==" }],
        target: { kind: "s3" },
      }),
    ).toThrow(/target/i);
  });
});

describe("wantsJson", () => {
  it("asks for json only when to_formats lists it", () => {
    expect(wantsJson({ to_formats: ["md", "json"] })).toBe(true);
    expect(wantsJson({ to_formats: ["md"] })).toBe(false);
    expect(wantsJson({})).toBe(false);
  });
});

describe("toConvertDocumentResponse", () => {
  it("maps a conversion into the docling-serve response shape", () => {
    const out = toConvertDocumentResponse(CONVERSION, { json: false, warnings: [] });

    expect(out.status).toBe("success");
    expect(out.document?.filename).toBe("report.pdf");
    expect(out.document?.md_content).toBe(CONVERSION.markdown);
    // Only the requested formats are populated; the rest are null, as upstream.
    expect(out.document?.json_content).toBeNull();
    expect(out.document?.html_content).toBeNull();
    expect(out.errors).toEqual([]);
    // Seconds, not milliseconds: upstream reports processing_time in seconds.
    expect(out.processing_time).toBeCloseTo(2.7, 2);
  });

  it("includes the chunks as json_content when json was asked for", () => {
    const out = toConvertDocumentResponse(CONVERSION, { json: true, warnings: [] });
    expect(out.document?.json_content).not.toBeNull();
  });

  // An ignored option is not a failure, but it is not a clean success either.
  it("reports partial_success when options were ignored, naming them", () => {
    const out = toConvertDocumentResponse(CONVERSION, {
      json: false,
      warnings: [{ option: "table_mode", detail: "not supported" }],
    });
    expect(out.status).toBe("partial_success");
    expect(out.errors).toHaveLength(1);
    expect(JSON.stringify(out.errors)).toContain("table_mode");
  });
});

// The service measures more than docling-serve's shape has room for: how much
// of the text survived, where the text came from, whether a scan is worth
// offering OCR for, the figures it cut. Upstream has no field for any of it, so
// it travels in a block of our own that an upstream-shaped client ignores.
describe("toConvertDocumentResponse: this service's own measurements", () => {
  const RICH = {
    ...CONVERSION,
    backend: "docling.rs",
    textSource: "pdfjs",
    needsOcr: false,
    pages: 12,
    quality: { coverage: 0.94, garbled: false },
    ocrOffer: { via: "tesseract", estimateSeconds: 30 },
    figures: [{ id: "p1-f1", base64: "iVBOR" }],
    figureStats: { kept: 1, dropped: 0 },
  };

  it("carries them under a namespace of its own, beside the upstream fields", () => {
    const out = toConvertDocumentResponse(RICH, { json: false, warnings: [] });

    // The upstream contract is untouched.
    expect(out.document?.md_content).toBe(CONVERSION.markdown);
    expect(out.status).toBe("success");

    expect(out.powerhouse).toMatchObject({
      backend: "docling.rs",
      textSource: "pdfjs",
      needsOcr: false,
      pages: 12,
      quality: { coverage: 0.94, garbled: false },
      ocrOffer: { via: "tesseract", estimateSeconds: 30 },
      figureStats: { kept: 1, dropped: 0 },
    });
    expect(out.powerhouse?.figures).toHaveLength(1);
  });

  // A plain conversion measured none of this; an object of nulls would be
  // noise, and a client reading `powerhouse?.quality` handles both the same.
  it("leaves the block out when there was nothing to put in it", () => {
    const out = toConvertDocumentResponse(CONVERSION, { json: false, warnings: [] });
    expect(out.powerhouse).toBeUndefined();
  });

  it("omits what was not measured rather than reporting it as null", () => {
    const out = toConvertDocumentResponse(
      { ...CONVERSION, textSource: "docling", quality: null, figures: [] },
      { json: false, warnings: [] },
    );
    expect(out.powerhouse).toEqual({ textSource: "docling" });
  });
});
