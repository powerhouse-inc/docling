import { describe, expect, it } from "vitest";
import {
  doclingOptionsFromQuery,
  doclingOptionsFromV1,
  hasConvertOptions,
} from "./convert-options.mjs";

const q = (s: string) => new URLSearchParams(s);

describe("doclingOptionsFromQuery", () => {
  it("is empty for a bare request", () => {
    const out = doclingOptionsFromQuery(q("filename=a.pdf"));
    expect(out.convert).toEqual({});
    expect(out.chunk).toEqual({});
    expect(hasConvertOptions(out)).toBe(false);
  });

  // ?ocr=1 predates this and must keep meaning what it meant.
  it("keeps ocr=1 meaning a forced full-page OCR", () => {
    expect(doclingOptionsFromQuery(q("ocr=1")).convert).toEqual({
      forceFullPageOcr: true,
    });
  });

  it("reads the OCR controls", () => {
    expect(
      doclingOptionsFromQuery(q("ocrLang=de,en&ocrMode=accurate&ocrScale=2")).convert,
    ).toEqual({ ocrLang: "de,en", ocrMode: "accurate", ocrScale: 2 });
  });

  it("reads the layout and table switches", () => {
    expect(
      doclingOptionsFromQuery(
        q("headingHierarchy=1&compactTables=1&skipEmptyCells=1&noTextPanels=1"),
      ).convert,
    ).toEqual({
      headingHierarchy: true,
      compactTables: true,
      skipEmptyCells: true,
      noTextPanels: true,
    });
  });

  it("reads the enrichment switches", () => {
    expect(
      doclingOptionsFromQuery(
        q("doCodeEnrichment=1&doFormulaEnrichment=1&doPictureClassification=1"),
      ).convert,
    ).toEqual({
      doCodeEnrichment: true,
      doFormulaEnrichment: true,
      doPictureClassification: true,
    });
  });

  it("reads the ASR controls", () => {
    expect(
      doclingOptionsFromQuery(q("asrModel=whisper-tiny&asrLang=de&videoFrames=8")).convert,
    ).toEqual({ asrModel: "whisper-tiny", asrLang: "de", videoFrames: 8 });
  });

  it("reads the VLM controls", () => {
    expect(
      doclingOptionsFromQuery(
        q("pipeline=vlm&vlmModel=m&vlmEndpoint=http://x&vlmMaxTokens=512"),
      ).convert,
    ).toEqual({
      pipeline: "vlm",
      vlmModel: "m",
      vlmEndpoint: "http://x",
      vlmMaxTokens: 512,
    });
  });

  it("reads the chunker settings into their own bag", () => {
    const out = doclingOptionsFromQuery(q("chunker=hybrid&maxTokens=512&mergePeers=0"));
    expect(out.chunk).toEqual({ chunker: "hybrid", maxTokens: 512, mergePeers: false });
    expect(out.convert).toEqual({});
  });

  it("ignores a parameter it does not know rather than passing it to the binding", () => {
    expect(doclingOptionsFromQuery(q("nonsense=1&job=x&figures=1")).convert).toEqual({});
  });

  it("rejects a numeric option that is not a number", () => {
    expect(() => doclingOptionsFromQuery(q("ocrScale=big"))).toThrow(/ocrScale/);
    expect(() => doclingOptionsFromQuery(q("maxTokens=lots"))).toThrow(/maxTokens/);
  });
});

describe("doclingOptionsFromV1", () => {
  it("maps docling-serve's option names onto the binding's", () => {
    const out = doclingOptionsFromV1({
      force_ocr: true,
      ocr_lang: ["de", "en"],
      page_range: [2, 9],
      image_export_mode: "embedded",
      do_code_enrichment: true,
      do_formula_enrichment: true,
      do_picture_classification: true,
      abort_on_error: true,
      pipeline: "vlm",
    });

    expect(out.convert).toMatchObject({
      forceFullPageOcr: true,
      ocrLang: "de,en",
      pages: "2-9",
      imageMode: "embedded",
      doCodeEnrichment: true,
      doFormulaEnrichment: true,
      doPictureClassification: true,
      strict: true,
      pipeline: "vlm",
    });
    expect(out.warnings).toEqual([]);
  });

  // do_ocr is docling-serve's "run OCR at all"; the binding's opposite is skipOcr.
  it("turns do_ocr: false into skipOcr", () => {
    expect(doclingOptionsFromV1({ do_ocr: false }).convert).toEqual({ skipOcr: true });
    // true is the binding's own default, so nothing is sent.
    expect(doclingOptionsFromV1({ do_ocr: true }).convert).toEqual({});
  });

  it("accepts a single page range as one page", () => {
    expect(doclingOptionsFromV1({ page_range: [4, 4] }).convert).toMatchObject({
      pages: "4",
    });
  });

  it("takes a comma string for ocr_lang as well as an array", () => {
    expect(doclingOptionsFromV1({ ocr_lang: "de,en" }).convert).toMatchObject({
      ocrLang: "de,en",
    });
  });

  // An option this service has no field for, but whose requested value is
  // what it already does, cost the caller nothing — so it is not a warning.
  // The piece sends table_mode and do_table_structure on every request
  // (both are required props with these defaults), and warning on them made
  // every single conversion partial_success, which drowns the real ones.
  it("is silent about an option whose value is what it already does", () => {
    const out = doclingOptionsFromV1({
      table_mode: "accurate",
      do_table_structure: true,
    });
    expect(out.warnings).toEqual([]);
    expect(out.convert).toEqual({});
  });

  // The other value of the same option is a real request that will not be
  // honoured, and that is still worth saying.
  it("still warns when the value asks for something it will not do", () => {
    expect(
      doclingOptionsFromV1({ table_mode: "fast" }).warnings.map((w) => w.option),
    ).toEqual(["table_mode"]);
    expect(
      doclingOptionsFromV1({ do_table_structure: false }).warnings.map((w) => w.option),
    ).toEqual(["do_table_structure"]);
  });

  // Options with no equivalent are still reported, so a caller learns its
  // setting did nothing rather than assuming it worked.
  it("warns about options the binding has no equivalent for", () => {
    const out = doclingOptionsFromV1({
      table_mode: "fast",
      pdf_backend: "pypdfium2",
      document_timeout: 30,
    });
    expect(out.warnings.map((w) => w.option).sort()).toEqual([
      "document_timeout",
      "pdf_backend",
      "table_mode",
    ]);
    expect(out.convert).toEqual({});
  });

  // Figures are this service's own pass over the pages, switched on with
  // /convert's ?figures=1 rather than any ConvertOptions field. include_images
  // is docling-serve's nearest question, so it is the one that turns it on.
  it("turns include_images into the service's own figures pass", () => {
    const out = doclingOptionsFromV1({ include_images: true });
    expect(out.service).toEqual({ figures: "1" });
    expect(out.convert).toEqual({});
    expect(out.warnings).toEqual([]);
  });

  it("does not ask for figures when include_images is false", () => {
    expect(doclingOptionsFromV1({ include_images: false }).service).toEqual({});
  });

  it("does not warn about to_formats, which is handled by the caller", () => {
    expect(doclingOptionsFromV1({ to_formats: ["md", "json"] }).warnings).toEqual([]);
  });

  it("is empty and silent for no options at all", () => {
    const out = doclingOptionsFromV1(undefined);
    expect(out.convert).toEqual({});
    expect(out.warnings).toEqual([]);
    expect(hasConvertOptions(out)).toBe(false);
  });
});

describe("hasConvertOptions", () => {
  // The warm pipeline ignores per-call options — measured, and the reason the
  // OCR path already bypasses it. Anything carrying options must do the same,
  // so the rest of the server needs to ask this question.
  it("is true only when a conversion option was actually set", () => {
    expect(hasConvertOptions(doclingOptionsFromQuery(q("ocr=1")))).toBe(true);
    expect(hasConvertOptions(doclingOptionsFromQuery(q("chunker=hybrid")))).toBe(false);
    expect(hasConvertOptions(doclingOptionsFromQuery(q("figures=1")))).toBe(false);
  });
});
