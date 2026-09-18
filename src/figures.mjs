/**
 * Figures for a source — the pictures and display formulas of a PDF, located.
 *
 * docling's JSON gives every picture with its PNG embedded (`image.uri`, with
 * page and box), and every display formula as a text item whose `text` is the
 * placeholder `<!-- formula-not-decoded -->` and whose `prov` is empty: no
 * box. But a display formula sits between two positioned paragraphs, so its
 * region is the vertical gap between the item before it and the item after it
 * in reading order, on that page. Measured on a 23-page paper: 72 of 79
 * formulas located this way; the other 7 straddle a page break and are left
 * as placeholders rather than guessed.
 *
 * Decoding formulas was measured first and rejected: CodeFormulaV2 did not
 * finish 79 formulas in ten minutes on CPU. A picture costs nothing to make
 * and a vision model reads it for ~1 000 tokens.
 *
 * Everything here is pure: reading order, regions, pixel maths, placeholder
 * indexing and the byte budget. Rendering and cropping live in the server.
 */

export const FORMULA_PLACEHOLDER = "<!-- formula-not-decoded -->";
export const PICTURE_PLACEHOLDER = "<!-- image -->";
/** Points of padding around a located formula, so descenders are not clipped. */
export const FORMULA_PAD_PT = 4;
/** A gap narrower than this is line spacing, not a formula; wider than the page is a layout error. */
export const MIN_FORMULA_GAP_PT = 12;
export const MAX_FORMULA_GAP_PT = 400;
export const DEFAULT_MAX_FIGURE_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {{ l: number; t: number; r: number; b: number }} Box  BOTTOMLEFT origin, points
 * @typedef {{ page: number; box: Box; placeholderIndex: number }} FormulaRegion
 * @typedef {{ page: number; box: Box | null; placeholderIndex: number; png: string; caption: string; width: number; height: number }} PictureFigure
 * @typedef {{ id: string; kind: "picture" | "formula"; page: number; box: Box | null; placeholderIndex: number; caption?: string; alt: string; mimeType: string; width: number; height: number; bytesBase64: string }} Figure
 */

/**
 * Items in the order the markdown is written: `body.children`, descending into
 * groups (lists) but not into pictures (their children are captions, written
 * separately).
 * @param {any} doc
 * @returns {any[]}
 */
export function readingOrder(doc) {
  const byRef = new Map();
  for (const key of ["texts", "pictures", "tables", "groups"])
    for (const item of doc[key] ?? []) byRef.set(item.self_ref, item);
  const out = [];
  const walk = (refs) => {
    for (const ref of refs ?? []) {
      const item = byRef.get(ref.$ref);
      if (!item) continue;
      out.push(item);
      if (
        item.children?.length &&
        item.label !== "picture" &&
        item.label !== "table"
      )
        walk(item.children);
    }
  };
  walk(doc.body?.children);
  return out;
}

const isFormula = (item) => item?.text === FORMULA_PLACEHOLDER;
const firstProv = (item) => (item?.prov?.length ? item.prov[0] : null);

/**
 * Where each display formula sits: the gap between its positioned neighbours.
 * `placeholderIndex` is the n-th FORMULA_PLACEHOLDER in the markdown, which is
 * the n-th formula in reading order.
 * @param {any} doc
 * @returns {{ regions: FormulaRegion[]; total: number; skipped: number }}
 */
export function formulaRegions(doc) {
  const order = readingOrder(doc);
  const regions = [];
  let index = -1;
  let skipped = 0;
  for (let i = 0; i < order.length; i++) {
    if (!isFormula(order[i])) continue;
    index += 1;
    let p = i - 1;
    while (p >= 0 && !firstProv(order[p])) p--;
    let n = i + 1;
    while (n < order.length && !firstProv(order[n])) n++;
    const prev = firstProv(order[p]);
    const next = firstProv(order[n]);
    if (!prev || !next || prev.page_no !== next.page_no) {
      skipped += 1;
      continue;
    }
    const gap = prev.bbox.b - next.bbox.t;
    if (gap < MIN_FORMULA_GAP_PT || gap > MAX_FORMULA_GAP_PT) {
      skipped += 1;
      continue;
    }
    // Several formulas in one gap share it: split evenly in reading order.
    const between = order.slice(p + 1, n);
    const run = between.filter(isFormula).length;
    const position = between.slice(0, i - (p + 1)).filter(isFormula).length;
    const slot = gap / run;
    const top = prev.bbox.b - slot * position;
    regions.push({
      page: prev.page_no,
      box: {
        l: Math.min(prev.bbox.l, next.bbox.l) - FORMULA_PAD_PT,
        t: top + FORMULA_PAD_PT,
        r: Math.max(prev.bbox.r, next.bbox.r) + FORMULA_PAD_PT,
        b: top - slot - FORMULA_PAD_PT,
      },
      placeholderIndex: index,
    });
  }
  return { regions, total: index + 1, skipped };
}

/**
 * The pictures, with the PNG docling embedded and the caption it attached.
 * `placeholderIndex` is the n-th PICTURE_PLACEHOLDER in the markdown.
 * @param {any} doc
 * @returns {PictureFigure[]}
 */
export function pictureFigures(doc) {
  const byRef = new Map((doc.texts ?? []).map((t) => [t.self_ref, t]));
  const order = readingOrder(doc);
  const out = [];
  let index = -1;
  for (const item of order) {
    if (item.label !== "picture") continue;
    index += 1;
    const uri = item.image?.uri ?? "";
    const m = /^data:image\/png;base64,(.+)$/s.exec(uri);
    if (!m) continue; // no embedded image: the placeholder stays
    const prov = firstProv(item);
    const caption = (item.captions ?? [])
      .map((c) => byRef.get(c.$ref)?.text ?? "")
      .filter(Boolean)
      .join(" ");
    out.push({
      page: prov?.page_no ?? 0,
      box: prov?.bbox ?? null,
      placeholderIndex: index,
      png: m[1],
      caption,
      width: item.image?.size?.width ?? 0,
      height: item.image?.size?.height ?? 0,
    });
  }
  return out;
}

/**
 * A BOTTOMLEFT point box → a TOPLEFT pixel rectangle on a page rendered at `dpi`.
 * Clamped to the page, integer, never empty.
 * @param {Box} box
 * @param {{ width: number; height: number }} pageSize  points
 * @param {number} dpi
 * @returns {{ left: number; top: number; width: number; height: number }}
 */
export function toPixels(box, pageSize, dpi) {
  const s = dpi / 72;
  const pw = Math.round(pageSize.width * s);
  const ph = Math.round(pageSize.height * s);
  const left = Math.max(0, Math.floor(box.l * s));
  const top = Math.max(0, Math.floor((pageSize.height - box.t) * s));
  const right = Math.min(pw, Math.ceil(box.r * s));
  const bottom = Math.min(ph, Math.ceil((pageSize.height - box.b) * s));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * Replace the n-th occurrence of `placeholder` with `replacement`. Returns the
 * text unchanged when there is no n-th occurrence.
 * @param {string} text
 * @param {string} placeholder
 * @param {number} index
 * @param {string} replacement
 */
export function replacePlaceholder(text, placeholder, index, replacement) {
  let from = 0;
  for (let i = 0; ; i++) {
    const at = text.indexOf(placeholder, from);
    if (at === -1) return text;
    if (i === index)
      return (
        text.slice(0, at) + replacement + text.slice(at + placeholder.length)
      );
    from = at + placeholder.length;
  }
}

/**
 * The rows of a crop that hold the formula, not the slivers of the lines
 * above and below it. The neighbours' boxes include their line spacing, so a
 * gap-located crop starts with the bottom of one line and ends with the top of
 * the next. Given per-row ink counts, find bands of inked rows separated by at
 * least `minGap` blank rows and keep the band(s) that do not touch the top or
 * bottom edge; if every band touches an edge (a tall formula filling the
 * crop), keep everything.
 * @param {number[]} rowInk  ink pixels per row, top to bottom
 * @param {{ minGap?: number; blank?: number }} [options]
 * @returns {{ top: number; height: number }}  rows to keep
 */
export function interiorRows(rowInk, options = {}) {
  const minGap = options.minGap ?? 3;
  const blank = options.blank ?? 0;
  const bands = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y < rowInk.length; y++) {
    const inked = rowInk[y] > blank;
    if (inked) {
      if (start === -1) start = y;
      gap = 0;
    } else if (start !== -1) {
      gap += 1;
      if (gap >= minGap) {
        bands.push({ top: start, bottom: y - gap });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start !== -1) bands.push({ top: start, bottom: rowInk.length - 1 - gap });
  const all = { top: 0, height: rowInk.length };
  if (bands.length === 0) return all;
  const interior = bands.filter(
    (b) => b.top > 0 && b.bottom < rowInk.length - 1,
  );
  if (interior.length === 0) return all;
  const top = interior[0].top;
  const bottom = interior[interior.length - 1].bottom;
  const pad = 2;
  return {
    top: Math.max(0, top - pad),
    height: Math.min(rowInk.length, bottom + pad + 1) - Math.max(0, top - pad),
  };
}

/** The alt text a reader — human or model — sees before the image loads, or instead of it. */
export function altFor(figure) {
  const where = figure.page ? `, page ${figure.page}` : "";
  return figure.kind === "formula"
    ? `formula ${figure.placeholderIndex + 1}${where} — not decoded`
    : `figure ${figure.placeholderIndex + 1}${where}${figure.caption ? ` — ${figure.caption}` : ""}`;
}

/**
 * Keep the figures within `maxBytes` of base64: formulas are dropped first
 * (a placeholder loses less than a chart does), then pictures, from the end.
 * @param {Figure[]} figures
 * @param {number} maxBytes
 * @returns {{ kept: Figure[]; dropped: number }}
 */
export function applyBudget(figures, maxBytes = DEFAULT_MAX_FIGURE_BYTES) {
  const size = (f) => f.bytesBase64.length;
  let total = figures.reduce((n, f) => n + size(f), 0);
  if (total <= maxBytes) return { kept: figures, dropped: 0 };
  const kept = new Set(figures);
  const order = [
    ...figures.filter((f) => f.kind === "formula").reverse(),
    ...figures.filter((f) => f.kind === "picture").reverse(),
  ];
  let dropped = 0;
  for (const f of order) {
    if (total <= maxBytes) break;
    kept.delete(f);
    total -= size(f);
    dropped += 1;
  }
  return { kept: figures.filter((f) => kept.has(f)), dropped };
}
