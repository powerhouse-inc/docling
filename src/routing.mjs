// @ts-check
/**
 * How a PDF gets read, decided from what the file is and what this machine
 * has — a pure function, so it is tested on its own and the service only
 * carries the plumbing.
 *
 * The ladder, cheapest rung first (numbers measured on 2026-09-18):
 *
 *   0. docling's plain pass — always first; seconds.
 *   1. pdf.js text extraction — when pdfium returns glyph soup but the text
 *      layer is fine (Type 3 fonts under custom encodings: pdfium 96 %
 *      single-character tokens, pdf.js 1.2 %). Pure npm, 0.4 s for 19 pages,
 *      runs wherever Node runs. No layout, so the sections come from the
 *      floor/ceiling rule alone.
 *   2. Tesseract via ocrmypdf — a real scan (pdf.js finds no words either).
 *      Needs `ocrmypdf` + `tesseract` on PATH; ~2.6 s/page single-threaded,
 *      parallel across cores.
 *   3. docling's bundled OCR — same case, no Tesseract; 8.6 s/page, most
 *      cores. Automatic only under a time budget; offered above it.
 *
 * Nothing here installs anything: capabilities are detected and reported,
 * and the response says which rung produced the text.
 */

/**
 * Whether extracted text is glyph soup rather than words.
 *
 * Measured on a 19-page report re-exported with Type 3 fonts: pdfium returned
 * `E x e c u t i v e S u m m a ry` — 96 % of whitespace-separated tokens a
 * single character. Prose sits at 1–5 %. A maths paper read correctly sits at
 * ~30 % (variables, `F 2`, subscripts), which is why the threshold is 0.5 and
 * not lower. Below MIN_TOKENS there is not enough text to judge.
 */
export const GARBLE_RATIO = 0.5;
export const MIN_TOKENS = 40;

/** @param {string} text */
export function looksGarbled(text) {
  const tokens = text
    .replace(/<!--.*?-->/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (tokens.length < MIN_TOKENS) return false;
  const single = tokens.filter((t) => t.length === 1).length;
  return single / tokens.length > GARBLE_RATIO;
}

/** Measured seconds per page, used only for the estimate a user is shown. */
/**
 * Seconds per page for the whole Tesseract re-read — ocrmypdf (already parallel
 * across cores) plus docling's pass on the result. Measured 2026-09-18 on the
 * 19-page Sky report, `--force-ocr`, 8 cores: ocrMs 113 s + convert 20 s +
 * chunk 23 s = 156 s → 8.2 s/page. The earlier 2.6 s/page ÷ jobs figure came
 * from a `--skip-text` run that OCR'd nothing.
 */
export const TESSERACT_SECONDS_PER_PAGE = 8;
export const DOCLING_OCR_SECONDS_PER_PAGE = 8.6;

/**
 * @typedef {{ tesseract: boolean; ocrmypdf: boolean; doclingOcr: boolean }} OcrCapabilities
 * @typedef {{ kind: "docling" }
 *   | { kind: "pdfjs" }
 *   | { kind: "tesseract"; mode: "skip-text" | "force-ocr"; estimateSeconds: number }
 *   | { kind: "docling-ocr"; estimateSeconds: number }
 *   | { kind: "needs-ocr"; via: "tesseract" | "docling-ocr"; estimateSeconds: number }
 *   | { kind: "unreadable" }} Route
 */

/**
 * @param {{
 *   doclingGarbled: boolean;
 *   pdfjs: { garbled: boolean; chars: number } | null;
 *   pages: number;
 *   capabilities: OcrCapabilities;
 *   forceOcr: boolean;
 *   autoOcrBudgetSeconds: number;
 *   jobs: number;
 * }} input
 * @returns {Route}
 */
export function decideRoute(input) {
  const {
    doclingGarbled,
    pdfjs,
    pages,
    capabilities,
    forceOcr,
    autoOcrBudgetSeconds,
  } = input;
  if (!doclingGarbled && !forceOcr) return { kind: "docling" };

  // The text layer is fine and only pdfium cannot read it: no OCR at all.
  const textLayerReadable =
    pdfjs !== null && !pdfjs.garbled && pdfjs.chars >= MIN_TOKENS;
  if (!forceOcr && textLayerReadable) return { kind: "pdfjs" };

  const tesseract = capabilities.tesseract && capabilities.ocrmypdf;
  if (!tesseract && !capabilities.doclingOcr) return { kind: "unreadable" };

  const via = tesseract ? "tesseract" : "docling-ocr";
  const perPage = tesseract
    ? TESSERACT_SECONDS_PER_PAGE
    : DOCLING_OCR_SECONDS_PER_PAGE;
  const estimateSeconds = Math.max(1, Math.round(Math.max(1, pages) * perPage));

  if (!forceOcr && estimateSeconds > autoOcrBudgetSeconds)
    return { kind: "needs-ocr", via, estimateSeconds };
  if (via === "tesseract") {
    // When docling's own read came back garbled, the text layer is what
    // defeats it and must be replaced — whether or not pdf.js can read it.
    // --skip-text would leave every page's layer in place (a report whose
    // fonts pdfium cannot decode has text on every page) and hand docling the
    // same soup back; --force-ocr rasterises and re-reads them all. Only a
    // forced OCR of a file docling read fine keeps --skip-text: OCR the image
    // pages, keep the trustworthy text.
    const mode = doclingGarbled ? "force-ocr" : "skip-text";
    return { kind: "tesseract", mode, estimateSeconds };
  }
  return { kind: "docling-ocr", estimateSeconds };
}
