// @ts-check
/**
 * How much of the file made it into the conversion — measured, not judged.
 *
 * `coverage` is the fraction of the PDF's own text-layer tokens (read by
 * pdf.js, with multiplicity) that appear in the converted markdown. It is a
 * floor on completeness, not a proof of it: it cannot see meaning, only
 * tokens, and a formula the layout reader dropped shows up as the missing
 * symbols around a `formula-not-decoded` placeholder. Measured 2026-09-18:
 * a report read through pdf.js 100 %; a CV 98.2 %; a maths paper 96.9 % with
 * 79 undecoded formulas — the 3.1 % gap is those formulas' glyphs.
 *
 * The counts are the losses the converter announces itself: formulas it saw
 * but did not decode, pictures it saw but did not transcribe.
 */

/**
 * Tokens: letters and digits, lower-cased, at least two characters (single glyphs are noise on both sides).
 * @param {string} text
 * @returns {string[]}
 */
export function tokens(text) {
  return text
    .toLowerCase()
    .replace(/<!--.*?-->/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * @param {string} rawText   the PDF's text layer, as pdf.js reads it ("" when there is none)
 * @param {string} markdown  the converted document
 * @returns {{ coverage: number | null; rawTokens: number; formulas: { total: number; decoded: number }; images: number }}
 */
export function conversionQuality(rawText, markdown) {
  const raw = new Map();
  for (const t of tokens(rawText)) raw.set(t, (raw.get(t) ?? 0) + 1);
  const got = new Map();
  for (const t of tokens(markdown)) got.set(t, (got.get(t) ?? 0) + 1);
  let total = 0;
  let hit = 0;
  for (const [t, n] of raw) {
    total += n;
    hit += Math.min(n, got.get(t) ?? 0);
  }
  const undecoded = (markdown.match(/formula-not-decoded/g) ?? []).length;
  const decoded = Math.floor((markdown.match(/\$\$/g) ?? []).length / 2);
  return {
    // Too little text to say anything (a scan, a cover): null, not 0 or 1.
    coverage: total >= 40 ? Math.round((hit / total) * 1000) / 1000 : null,
    rawTokens: total,
    formulas: { total: undecoded + decoded, decoded },
    images: (markdown.match(/<!--\s*image\s*-->/g) ?? []).length,
  };
}
