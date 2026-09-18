export function tokens(text: string): string[];
export type ConversionQuality = {
  /** Fraction of the text layer's tokens present in the conversion; null when there is too little text to judge. */
  coverage: number | null;
  rawTokens: number;
  formulas: { total: number; decoded: number };
  images: number;
};
export function conversionQuality(rawText: string, markdown: string): ConversionQuality;
