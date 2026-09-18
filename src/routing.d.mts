export const GARBLE_RATIO: number;
export const MIN_TOKENS: number;
export const TESSERACT_SECONDS_PER_PAGE: number;
export const DOCLING_OCR_SECONDS_PER_PAGE: number;
export function looksGarbled(text: string): boolean;
export type OcrCapabilities = { tesseract: boolean; ocrmypdf: boolean; doclingOcr: boolean };
export type Route =
  | { kind: "docling" }
  | { kind: "pdfjs" }
  | { kind: "tesseract"; mode: "skip-text" | "force-ocr"; estimateSeconds: number }
  | { kind: "docling-ocr"; estimateSeconds: number }
  | { kind: "needs-ocr"; via: "tesseract" | "docling-ocr"; estimateSeconds: number }
  | { kind: "unreadable" };
export function decideRoute(input: {
  doclingGarbled: boolean;
  pdfjs: { garbled: boolean; chars: number } | null;
  pages: number;
  capabilities: OcrCapabilities;
  forceOcr: boolean;
  autoOcrBudgetSeconds: number;
  jobs: number;
}): Route;
