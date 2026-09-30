import { describe, expect, it } from "vitest";
import {
  parseSourceRequest,
  toConvertDocumentResponse,
  unsupportedOptionWarnings,
  wantsJson,
  wantsOcr,
} from "./v1.mjs";

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

describe("wantsJson / wantsOcr", () => {
  it("asks for json only when to_formats lists it", () => {
    expect(wantsJson({ to_formats: ["md", "json"] })).toBe(true);
    expect(wantsJson({ to_formats: ["md"] })).toBe(false);
    expect(wantsJson({})).toBe(false);
  });

  // do_ocr defaults true upstream, but this service decides OCR from the file
  // itself; only an explicit force is passed on as ?ocr=1.
  it("forces OCR only when force_ocr is set", () => {
    expect(wantsOcr({ force_ocr: true })).toBe(true);
    expect(wantsOcr({ do_ocr: true })).toBe(false);
    expect(wantsOcr({})).toBe(false);
  });
});

describe("unsupportedOptionWarnings", () => {
  // Accepting an option and ignoring it is the failure mode worth avoiding:
  // a workflow sets table_mode, sees success, and never learns it did nothing.
  it("names every option this service cannot honour", () => {
    const warnings = unsupportedOptionWarnings({
      to_formats: ["md"],
      force_ocr: true,
      table_mode: "accurate",
      page_range: [1, 5],
      pdf_backend: "pypdfium2",
      do_code_enrichment: true,
    });
    const named = warnings.map((w) => w.option).sort();
    expect(named).toEqual([
      "do_code_enrichment",
      "page_range",
      "pdf_backend",
      "table_mode",
    ]);
  });

  it("says nothing about the options it does honour", () => {
    expect(
      unsupportedOptionWarnings({ to_formats: ["md", "json"], force_ocr: true, do_ocr: false }),
    ).toEqual([]);
  });

  it("says nothing for an absent options block", () => {
    expect(unsupportedOptionWarnings(undefined)).toEqual([]);
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
