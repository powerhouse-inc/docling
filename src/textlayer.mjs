/**
 * Structure for the pdf.js rung — headings and paragraphs from geometry.
 *
 * When a PDF's fonts defeat docling's layout reader, the routing ladder falls
 * back to pdf.js's text layer: a stream of positioned strings with no
 * document structure. Read flat, a 23-page report became 811 lines with no
 * heading and no paragraph. But the stream carries geometry, and the geometry
 * is regular (measured on that report): body text at one dominant type size
 * (20 pt, 3 008 chars), section headings at 1.5× (30), page titles at 3× (60),
 * lines 1.3 sizes apart inside a paragraph and 2.6 apart between paragraphs.
 *
 * So: the modal size (by characters) is the body; a block whose size is
 * ≥ 1.35× body is a heading (`#` at ≥ 2.4×, `##` otherwise); lines whose
 * vertical gap exceeds 1.7 sizes, or whose size class changes, or that jump
 * back up the page (a new column), start a new block; lines inside a block are
 * joined with a space so the paragraph reflows. Items on one line are joined
 * without a space when the horizontal gap is below 0.15 sizes (pdf.js splits
 * runs at font changes: "$123.79M," + "ending").
 *
 * What this cannot do, and says so: tables (columns come out as lines),
 * bullets (indent is not reliably a list), and spaces the PDF itself put
 * inside words ("und erlying" is a single string in the file). Tesseract
 * through ocrmypdf recovers the first — the UI offers it.
 */

export const HEADING_RATIO = 1.35;
export const TITLE_RATIO = 2.4;
/** Vertical gap (in multiples of the line's size) that separates paragraphs. */
export const PARAGRAPH_GAP = 1.7;

/** A figure's own text is short: a title, a legend, ticks, data labels. Longer lines are the document's prose, not the picture's. */
export const FIGURE_LABEL_MAX_CHARS = 120;
/** Horizontal gap (in sizes) below which two runs on a line are one word. */
export const GLUE_GAP = 0.15;

/**
 * @typedef {{ str: string; size: number; x: number; y: number; width: number; eol: boolean }} Run
 * @typedef {{ text: string; size: number; x: number; xEnd: number; y: number; hardBreak: boolean }} Line
 */

/**
 * A pdf.js text item, reduced to what the structuring needs.
 * @param {{ str: string; transform: number[]; width: number; hasEOL: boolean }} item
 * @returns {Run}
 */
export function runFromItem(item) {
  const [a, b, , , x, y] = item.transform;
  return {
    str: item.str,
    size: Math.hypot(a, b),
    x,
    y,
    width: item.width,
    eol: item.hasEOL,
  };
}

/**
 * Group runs into visual lines, following the stream order (which keeps
 * columns together — pdf.js emits a column at a time).
 * @param {Run[]} runs
 * @returns {Line[]}
 */
export function linesFromRuns(runs) {
  /** @type {Line[]} */
  const lines = [];
  /** @type {Line | null} */
  let current = null;
  for (const run of runs) {
    if (run.str === "") {
      // pdf.js emits an empty EOL run at every line break of the stream.
      if (run.eol && current) current.hardBreak = current.hardBreak || false;
      continue;
    }
    const size = run.size || current?.size || 1;
    const sameLine =
      current !== null &&
      Math.abs(run.y - current.y) < 0.5 * size &&
      run.x >= current.xEnd - 0.5 * size;
    if (sameLine && current) {
      const gap = run.x - current.xEnd;
      const glue =
        gap < GLUE_GAP * size &&
        !/\s$/.test(current.text) &&
        !/^\s/.test(run.str);
      current.text += (glue ? "" : " ") + run.str;
      current.xEnd = run.x + run.width;
      current.hardBreak = /\n\s*\n/.test(run.str);
    } else {
      current = {
        text: run.str,
        size,
        x: run.x,
        xEnd: run.x + run.width,
        y: run.y,
        hardBreak: /\n\s*\n/.test(run.str),
      };
      lines.push(current);
    }
  }
  for (const line of lines) line.text = line.text.replace(/\s+/g, " ").trim();
  return lines.filter((l) => l.text.length > 0);
}

/**
 * The type size most of the characters are set in — the body.
 * @param {Line[]} lines
 * @returns {number}
 */
export function bodySize(lines) {
  /** @type {Map<number, number>} */
  const chars = new Map();
  for (const l of lines) {
    const k = Math.round(l.size);
    chars.set(k, (chars.get(k) ?? 0) + l.text.length);
  }
  let best = 0;
  let bestChars = -1;
  for (const [k, n] of chars) if (n > bestChars) [best, bestChars] = [k, n];
  return best || 1;
}

/**
 * Lines → blocks (a heading or a paragraph each), in reading order.
 * @param {Line[]} lines
 * @param {number} body
 * @returns {{ kind: "title" | "heading" | "paragraph"; text: string }[]}
 */
export function blocksFromLines(lines, body) {
  /** @type {{ kind: "title" | "heading" | "paragraph"; text: string; size: number }[]} */
  const blocks = [];
  /** @type {Line | null} */
  let prev = null;
  for (const line of lines) {
    const ratio = line.size / body;
    const kind =
      ratio >= TITLE_RATIO
        ? "title"
        : ratio >= HEADING_RATIO
          ? "heading"
          : "paragraph";
    const last = blocks.at(-1);
    const sizeChanged =
      prev !== null &&
      Math.abs(line.size - prev.size) > 0.2 * Math.min(line.size, prev.size);
    const gap = prev === null ? Infinity : prev.y - line.y;
    // A new block when the kind or the size class changes, the PDF itself
    // broke the paragraph, the line jumps back up the page (a new column or
    // page), or the vertical gap is a paragraph's, not a line's. The same rule
    // lets a two-line heading stay one heading.
    const startsBlock =
      !last ||
      last.kind !== kind ||
      sizeChanged ||
      prev?.hardBreak === true ||
      gap < 0 ||
      gap > PARAGRAPH_GAP * line.size;
    if (startsBlock)
      blocks.push({
        kind,
        text: line.text,
        size: line.size,
        top: line.y + line.size,
        bottom: line.y,
        left: line.x,
        right: line.xEnd,
      });
    else if (last) {
      last.text += " " + line.text;
      last.bottom = line.y; // the block now reaches down to this line
      last.left = Math.min(last.left, line.x);
      last.right = Math.max(last.right, line.xEnd);
    }
    prev = line;
  }
  return blocks.map(({ kind, text, top, bottom, left, right }) => ({
    kind,
    text,
    top,
    bottom,
    left,
    right,
  }));
}

/**
 * One page's runs → markdown.
 * @param {Run[]} runs
 * @param {number} body  the document-wide body size
 * @returns {string}
 */
/** One block as markdown: `#` for a title, `##` for a heading, the text otherwise, or a placeholder line. */
export function renderBlock(block) {
  if (block.kind === "placeholder") return block.text;
  return block.kind === "title"
    ? `# ${block.text}`
    : block.kind === "heading"
      ? `## ${block.text}`
      : block.text;
}

export function pageToMarkdown(runs, body) {
  return blocksFromLines(linesFromRuns(runs), body)
    .map(renderBlock)
    .join("\n\n");
}

/**
 * Every page's blocks with their vertical span (points, BOTTOMLEFT — the
 * same space as docling's boxes), so figures can be placed between them.
 * @param {Run[][]} pages
 * @returns {{ pages: { page: number; blocks: { kind: string; text: string; top: number; bottom: number }[] }[]; bodySize: number }}
 */
export function documentToBlocks(pages) {
  const allLines = pages.flatMap((runs) => linesFromRuns(runs));
  const body = bodySize(allLines);
  return {
    pages: pages.map((runs, i) => ({
      page: i + 1,
      blocks: blocksFromLines(linesFromRuns(runs), body),
    })),
    bodySize: body,
  };
}

/**
 * Replace the text blocks a table covers with the table itself.
 *
 * A table's cells arrive as ordinary blocks — on the Sky report's P&L page,
 * twenty fragments like `"$96.01M 100%"` — so the rendered table has to take
 * their place, or every number appears twice, once in a grid and once as
 * rubble. A block belongs to a table when its vertical middle is inside the
 * table's rows and it overlaps the table horizontally.
 * @param {{ kind: string; text: string; top: number; bottom: number; left?: number; right?: number }[]} blocks
 * @param {{ top: number; bottom: number; left: number; right: number; markdown: string }[]} tables
 */
export function spliceTables(blocks, tables) {
  let out = blocks.map((b) => ({ ...b }));
  for (const table of [...tables].sort((a, b) => b.top - a.top)) {
    const covered = (block) => {
      const middle = (block.top + block.bottom) / 2;
      if (middle > table.top || middle < table.bottom) return false;
      if (block.left === undefined || block.right === undefined) return true;
      return block.right >= table.left && block.left <= table.right;
    };
    const at = out.findIndex(covered);
    const kept = out.filter((block) => !covered(block));
    const insertion = {
      kind: "placeholder",
      text: table.markdown,
      top: table.top,
      bottom: table.bottom,
    };
    if (at === -1) kept.push(insertion);
    else kept.splice(Math.min(at, kept.length), 0, insertion);
    out = kept;
  }
  return out;
}

/** Whole pages of blocks as markdown, blank-line separated. */
export function renderPages(pageBlocks) {
  return pageBlocks
    .map(({ blocks }) =>
      blocks
        .map(renderBlock)
        .filter((t) => t.length > 0)
        .join("\n\n"),
    )
    .filter((page) => page.length > 0)
    .join("\n\n");
}

/**
 * Put a placeholder for each figure where it sits on its page: before the
 * first block that starts below the figure's top, else at the page's end.
 * Figures on one page go top to bottom. Returns the markdown and the figures
 * in the order their placeholders appear — the caller renumbers
 * `placeholderIndex` per kind from that order, because the n-th placeholder in
 * this markdown is what the source's content will carry.
 * @param {{ page: number; blocks: { kind: string; text: string; top: number; bottom: number }[] }[]} pageBlocks
 * @param {{ kind: "picture" | "formula"; page: number; box: { t: number; b: number } | null }[]} figures
 * @param {{ picture: string; formula: string }} placeholders
 * @returns {{ markdown: string; placed: typeof figures; unplaced: typeof figures }}
 */
/**
 * A chart draws its labels as live text on top of its picture, so they sit in
 * the text layer *and* in the image. Left alone they reach the markdown twice:
 * once in a picture a reader can see, once as rubble underneath it — on the
 * Sky report's collateral chart, `"$14B"`, `"$12B"`, `"$615.44M"` and 35 more,
 * 38 of that page's 93 runs, and 109 of the document's 1117.
 *
 * Absorbing them gives the figure its own text: the largest line becomes the
 * caption (and from there the alt text a model reads before it fetches the
 * image), the rest becomes one line marked as the figure's. Nothing is
 * discarded, so the coverage score stays true.
 *
 * Only short lines are taken. A picture that overlaps a paragraph — a page
 * background, a scan — must not swallow the document's prose, and the
 * difference that holds in practice is length: a chart's title, legend, ticks
 * and data labels are short; a body paragraph is not.
 * @param {{ kind: string; text: string; size: number; top: number; bottom: number; left?: number; right?: number }[]} blocks
 * @param {{ t: number; b: number; l: number; r: number }} box
 * @param {number} [maxChars]
 * @returns {{ kept: typeof blocks; caption: string | null; labels: string[] }}
 */
export function absorbFigureText(blocks, box, maxChars = FIGURE_LABEL_MAX_CHARS) {
  const top = Math.max(box.t, box.b);
  const bottom = Math.min(box.t, box.b);
  const left = Math.min(box.l, box.r);
  const right = Math.max(box.l, box.r);
  const inside = (b) => {
    if (b.kind === "placeholder") return false;
    if (b.text.length > maxChars) return false;
    const middle = (b.top + b.bottom) / 2;
    if (middle > top || middle < bottom) return false;
    if (b.left === undefined || b.right === undefined) return true;
    const centre = (b.left + b.right) / 2;
    return centre >= left && centre <= right;
  };
  const taken = blocks.filter(inside);
  if (taken.length === 0) return { kept: blocks, caption: null, labels: [] };
  const kept = blocks.filter((b) => !inside(b));
  // The caption is the figure's title: the largest line in the box, and the
  // highest of those when several share that size.
  const title = taken.reduce(
    (best, b) =>
      b.size > best.size || (b.size === best.size && b.top > best.top)
        ? b
        : best,
    taken[0],
  );
  return {
    kept,
    caption: title.text,
    labels: taken.filter((b) => b !== title).map((b) => b.text),
  };
}

/** The figure's own text, under its image: caption, then the labels. */
function figureTextBlock(caption, labels) {
  const parts = [];
  if (caption) parts.push(`*${caption}*`);
  if (labels.length > 0) parts.push(`*Figure text: ${labels.join(" \u00b7 ")}*`);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function insertFigurePlaceholders(pageBlocks, figures, placeholders) {
  const placed = [];
  const unplaced = [];
  const byPage = new Map();
  for (const f of figures) {
    if (!f.box || !f.page) {
      unplaced.push(f);
      continue;
    }
    if (!byPage.has(f.page)) byPage.set(f.page, []);
    byPage.get(f.page).push(f);
  }
  const parts = [];
  for (const { page, blocks } of pageBlocks) {
    let out = blocks.map((b) => ({ ...b }));
    const here = (byPage.get(page) ?? [])
      .slice()
      .sort((a, b) => b.box.t - a.box.t);
    byPage.delete(page);
    for (const f of here) {
      const { kept, caption, labels } = absorbFigureText(out, f.box);
      out = kept;
      let at = out.findIndex(
        (b) => b.kind !== "placeholder" && b.top < f.box.t,
      );
      if (at === -1) at = out.length;
      const insertion = [
        {
          kind: "placeholder",
          text: placeholders[f.kind],
          top: f.box.t,
          bottom: f.box.b,
        },
      ];
      const own = figureTextBlock(caption, labels);
      if (own !== null)
        insertion.push({
          kind: "placeholder",
          text: own,
          top: f.box.b,
          bottom: f.box.b,
        });
      out.splice(at, 0, ...insertion);
      placed.push(caption === null ? f : { ...f, caption });
    }
    // placeholders were spliced in page order top-down; report them in document order
    const rendered = out.map(renderBlock).filter((t) => t.length > 0);
    if (rendered.length > 0) parts.push(rendered.join("\n\n"));
  }
  // figures on pages beyond the text (or with no text at all): append, in page order
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    for (const f of byPage.get(page).sort((a, b) => b.box.t - a.box.t)) {
      parts.push(placeholders[f.kind]);
      placed.push(f);
    }
  }
  // `placed` must follow placeholder order in the markdown: within a page we
  // spliced top-down, which is document order; across pages, page order.
  return { markdown: parts.join("\n\n"), placed, unplaced };
}

/**
 * The whole document: body size is decided once across all pages, so a page
 * that is only a chart does not promote its labels to headings.
 * @param {Run[][]} pages
 * @returns {{ markdown: string; text: string; bodySize: number; headings: number }}
 */
export function documentToMarkdown(pages) {
  const allLines = pages.flatMap((runs) => linesFromRuns(runs));
  const body = bodySize(allLines);
  const parts = pages
    .map((runs) => pageToMarkdown(runs, body))
    .filter((p) => p.length > 0);
  const markdown = parts.join("\n\n");
  const text = pages
    .map((runs) =>
      runs
        .map((r) => r.str + (r.eol ? "\n" : " "))
        .join("")
        .trim(),
    )
    .join("\n\n");
  const headings = (markdown.match(/^#{1,2} /gm) ?? []).length;
  return { markdown, text, bodySize: body, headings };
}
