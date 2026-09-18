export interface Box { l: number; t: number; r: number; b: number }
export interface FormulaRegion { page: number; box: Box; placeholderIndex: number }
export interface PictureFigure { page: number; box: Box | null; placeholderIndex: number; png: string; caption: string; width: number; height: number }
export interface Figure {
  id: string;
  /** Where it sits on its page (points, BOTTOMLEFT); null when unknown. */
  box: Box | null;
  kind: "picture" | "formula";
  page: number;
  placeholderIndex: number; caption?: string;
  alt: string;
  mimeType: string;
  width: number;
  height: number;
  bytesBase64: string;
}
export const FORMULA_PLACEHOLDER: string;
export const PICTURE_PLACEHOLDER: string;
export const FORMULA_PAD_PT: number;
export const MIN_FORMULA_GAP_PT: number;
export const MAX_FORMULA_GAP_PT: number;
export const DEFAULT_MAX_FIGURE_BYTES: number;
export function readingOrder(doc: unknown): unknown[];
export function formulaRegions(doc: unknown): { regions: FormulaRegion[]; total: number; skipped: number };
export function pictureFigures(doc: unknown): PictureFigure[];
export function toPixels(box: Box, pageSize: { width: number; height: number }, dpi: number): { left: number; top: number; width: number; height: number };
export function replacePlaceholder(text: string, placeholder: string, index: number, replacement: string): string;
export function interiorRows(rowInk: number[], options?: { minGap?: number; blank?: number }): { top: number; height: number };
export function altFor(figure: { kind: "picture" | "formula"; page: number; placeholderIndex: number; caption?: string }): string;
export function applyBudget(figures: Figure[], maxBytes?: number): { kept: Figure[]; dropped: number };
