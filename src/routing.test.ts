import { describe, expect, it } from "vitest";
import { decideRoute, looksGarbled } from "./routing.mjs";

const all = { tesseract: true, ocrmypdf: true, doclingOcr: true };
const none = { tesseract: false, ocrmypdf: false, doclingOcr: false };
const base = {
  pages: 19,
  capabilities: all,
  forceOcr: false,
  autoOcrBudgetSeconds: 60,
  jobs: 8,
};
const clean = { garbled: false, chars: 30_000 };
const soup = { garbled: true, chars: 30_000 };

describe("looksGarbled", () => {
  it("flags pdfium's glyph soup", () => {
    expect(
      looksGarbled(
        "E x e c u t i v e S u m m a r y ".repeat(6) +
          "o w e r e d b y c c e l e r a t i n g",
      ),
    ).toBe(true);
  });
  it("does not flag prose, nor a maths paper's variables", () => {
    expect(
      looksGarbled(
        "Sky Protocol delivered its strongest quarter on record in Q1 2026, powered by accelerating adoption. ".repeat(
          4,
        ),
      ),
    ).toBe(false);
    // ~30 % single-letter tokens is what a correctly read maths paper looks like.
    const maths =
      "the flip graph over F 2 with rank r and matrices A B C of size n is connected by a b c d e ".repeat(
        3,
      );
    expect(looksGarbled(maths)).toBe(false);
  });
  it("refuses to judge a cover page", () => {
    expect(looksGarbled("S k y")).toBe(false);
  });
});

describe("decideRoute", () => {
  it("keeps docling's own result when it read words", () => {
    expect(
      decideRoute({ ...base, doclingGarbled: false, pdfjs: null }),
    ).toEqual({ kind: "docling" });
  });

  it("uses pdf.js when only pdfium cannot read the fonts — no OCR at all", () => {
    expect(
      decideRoute({ ...base, doclingGarbled: true, pdfjs: clean }),
    ).toEqual({ kind: "pdfjs" });
    // Even with no OCR available at all: this rung needs nothing.
    expect(
      decideRoute({
        ...base,
        capabilities: none,
        doclingGarbled: true,
        pdfjs: clean,
      }),
    ).toEqual({ kind: "pdfjs" });
  });

  it("OCRs a real scan with Tesseract when it is there and the estimate fits the budget", () => {
    const r = decideRoute({
      ...base,
      pages: 5,
      doclingGarbled: true,
      pdfjs: { garbled: false, chars: 5 },
    });
    expect(r).toMatchObject({ kind: "tesseract", mode: "force-ocr" });
    expect((r as { estimateSeconds: number }).estimateSeconds).toBe(5 * 8);
  });

  it("offers Tesseract instead of running it when 8 s/page overruns the budget — 19 pages is 2.5 minutes", () => {
    expect(
      decideRoute({
        ...base,
        doclingGarbled: true,
        pdfjs: { garbled: false, chars: 5 },
      }),
    ).toEqual({
      kind: "needs-ocr",
      via: "tesseract",
      estimateSeconds: 152,
    });
  });

  it("forces OCR on every page when the text layer lies to pdf.js as well", () => {
    expect(
      decideRoute({ ...base, pages: 5, doclingGarbled: true, pdfjs: soup }),
    ).toMatchObject({
      kind: "tesseract",
      mode: "force-ocr",
    });
  });

  it("replaces a layer pdfium cannot decode even when pdf.js reads it — the user asked for tables back", () => {
    // The Sky report: pdf.js reads the layer fine, docling does not. Forcing OCR
    // with --skip-text would keep every page's layer and return the same soup.
    expect(
      decideRoute({
        ...base,
        forceOcr: true,
        doclingGarbled: true,
        pdfjs: clean,
      }),
    ).toMatchObject({ kind: "tesseract", mode: "force-ocr" });
  });

  it("falls back to docling's bundled OCR without Tesseract, within the budget", () => {
    const caps = { ...all, tesseract: false };
    expect(
      decideRoute({
        ...base,
        capabilities: caps,
        pages: 5,
        doclingGarbled: true,
        pdfjs: soup,
      }),
    ).toEqual({ kind: "docling-ocr", estimateSeconds: 43 });
  });

  it("offers instead of running when the estimate is over the budget", () => {
    const caps = { ...all, tesseract: false };
    expect(
      decideRoute({
        ...base,
        capabilities: caps,
        pages: 19,
        doclingGarbled: true,
        pdfjs: soup,
      }),
    ).toEqual({
      kind: "needs-ocr",
      via: "docling-ocr",
      estimateSeconds: 163,
    });
  });

  it("runs regardless of budget when the caller asked for OCR", () => {
    const caps = { ...all, tesseract: false };
    expect(
      decideRoute({
        ...base,
        capabilities: caps,
        pages: 200,
        forceOcr: true,
        doclingGarbled: false,
        pdfjs: null,
      }),
    ).toMatchObject({ kind: "docling-ocr" });
    expect(
      decideRoute({
        ...base,
        forceOcr: true,
        doclingGarbled: false,
        pdfjs: clean,
      }),
    ).toMatchObject({ kind: "tesseract", mode: "skip-text" });
  });

  it("says unreadable when nothing can OCR", () => {
    expect(
      decideRoute({
        ...base,
        capabilities: none,
        doclingGarbled: true,
        pdfjs: soup,
      }),
    ).toEqual({ kind: "unreadable" });
  });
});
