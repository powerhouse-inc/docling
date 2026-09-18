/**
 * Tables from a text layer's geometry.
 *
 * docling reconstructs tables from pixels and writes them into its own
 * markdown — but only where its layout model calls something a table. On the
 * Sky quarterly report it called nothing a table (25 pictures, 0 tables), so
 * the appendix P&L reached the source as rubble: `"ACCOUNT"`, `"$96.01M
 * 100%"`, `"—"`, a fragment per block. The numbers were never lost — pdf.js
 * reads them exactly — only their shape was.
 *
 * So the shape is recovered from the positions. Runs sharing a baseline are a
 * row; the whitespace that persists down the page separates columns; a band of
 * rows that fills several columns with short, value-shaped cells is a table.
 *
 * Two things were learned from the real page and are load-bearing here:
 *
 * - **Columns come from whitespace, not from left edges.** A money column is
 *   right-aligned, so `$96.01M` begins at x=799 and `100%` at x=843 in the
 *   same column; clustering starts produced 15 columns where there are 6.
 * - **A table's own label rows are not tabular.** "Stability Fee Revenues"
 *   sits alone on its line; cutting the band there split one table into three.
 *
 * The value test is also what keeps prose out: a page of paragraphs has one
 * column, and the Sky report's grid of product cards has four columns of
 * *sentences*, which fails the test and stays prose — correctly, because it is.
 *
 * Not attempted: merged cells, spanning headers, and rules it never sees. This
 * returns the grid it can defend and leaves the rest as text.
 */

/** A cell that reads as a value rather than a sentence: a number, a share, a dash. */
const VALUE = /^[($]?-?[\d.,]+\s*[%KMB]?\)?$|^[—–-]$|^n\/?a$/i;

export const DEFAULT_TABLE_OPTIONS = {
  /** Same row when baselines differ by less than this share of the text size. */
  rowTolerance: 0.6,
  /** Whitespace narrower than this (points) does not separate two columns. */
  columnGap: 24,
  /** A table needs at least this many columns, counting the label column. */
  minColumns: 2,
  /** …and at least this many tabular rows. */
  minRows: 3,
  /**
   * A two-column table (label → value) is a real and common shape — the Sky
   * report's balance sheet is one — but two columns are also what a page of
   * prose with a sidebar looks like, so it has to show more evidence: more
   * rows, and almost every cell a value.
   */
  narrowColumns: 3,
  minRowsNarrow: 5,
  minValueShareNarrow: 0.85,
  /** …and this share of its non-label cells must look like values. */
  minValueShare: 0.6,
  /** A cell longer than this is prose, not a value. */
  maxCellChars: 24,
  /**
   * A table's label is a name, not a sentence. Without this, page 5 of the Sky
   * report — a prose column with a chart's axis ticks beside it — read as a
   * fifteen-row, two-column table and its paragraphs were replaced by one.
   */
  maxLabelChars: 40,
  /**
   * A column is filled row after row; a chart standing beside a table shares
   * its baselines, so the chart's labels land in the table's rows but occupy
   * their own band once or twice. Measured on the Sky report's page 8, where
   * "$5B Milestone (Feb 26)" sits on the same baseline as a metrics row.
   */
  minBandOccupancy: 0.4,
  /** An edge column standing this much further off than the table's own spacing is another block of content. */
  foreignColumnGap: 1.8,
  /** Label-only lines allowed between two tabular rows without ending the table. */
  maxRowsBetween: 3,
};

const isValue = (text, maxChars) => {
  const t = text.trim();
  return t.length > 0 && t.length <= maxChars && VALUE.test(t);
};

/**
 * Runs grouped into rows by baseline, each row left to right, top row first.
 * @param {{ str: string; x: number; y: number; width: number; size: number }[]} runs
 * @param {number} [tolerance]
 */
export function groupRows(
  runs,
  tolerance = DEFAULT_TABLE_OPTIONS.rowTolerance,
) {
  /** @type {{ y: number; runs: typeof runs }[]} */
  const rows = [];
  for (const run of runs) {
    if (!run.str.trim()) continue;
    const limit = Math.max(1, tolerance * (run.size || 10));
    const row = rows.find((r) => Math.abs(r.y - run.y) <= limit);
    if (row) row.runs.push(run);
    else rows.push({ y: run.y, runs: [run] });
  }
  for (const row of rows) row.runs.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y);
}

/**
 * The columns of a set of rows, as x intervals: every run's span projected
 * onto the x axis, then merged. What survives separate is a column.
 * @param {{ runs: { x: number; width: number }[] }[]} rows
 * @param {number} [gap]
 * @returns {{ left: number; right: number }[]}
 */
export function columnBands(rows, gap = DEFAULT_TABLE_OPTIONS.columnGap) {
  const spans = rows
    .flatMap((r) =>
      r.runs.map((run) => ({
        left: run.x,
        right: run.x + Math.max(1, run.width),
      })),
    )
    .sort((a, b) => a.left - b.left);
  const bands = [];
  for (const span of spans) {
    const last = bands.at(-1);
    if (last && span.left - last.right <= gap)
      last.right = Math.max(last.right, span.right);
    else bands.push({ ...span });
  }
  return bands;
}

/** The band a run sits in: the one containing its centre, else the nearest. */
/** The band a run is actually inside, or -1 — used once the bands have been filtered. */
function bandIn(run, bands) {
  const centre = run.x + Math.max(1, run.width) / 2;
  for (let i = 0; i < bands.length; i++)
    if (centre >= bands[i].left && centre <= bands[i].right) return i;
  return -1;
}

function bandOf(run, bands) {
  const centre = run.x + Math.max(1, run.width) / 2;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (centre >= band.left && centre <= band.right) return i;
    const distance =
      centre < band.left ? band.left - centre : centre - band.right;
    if (distance < bestDistance) [best, bestDistance] = [i, distance];
  }
  return best;
}

function isTabular(row, bands, o) {
  const label = row.runs
    .filter((run) => bandOf(run, bands) === 0)
    .map((run) => run.str.trim())
    .join(" ");
  if (label.length > o.maxLabelChars) return false;
  const beyondFirst = row.runs.filter((run) => bandOf(run, bands) > 0);
  if (beyondFirst.length === 0) return false;
  const valueRuns = beyondFirst.filter((run) =>
    isValue(run.str, o.maxCellChars),
  );
  const valueBands = new Set(valueRuns.map((run) => bandOf(run, bands)));
  // The row has to reach a table's shape on its own: a label column and at
  // least minColumns-1 columns of values. Judging it across the whole page
  // width instead let anything sharing a baseline — a chart beside the table —
  // decide whether the row counted.
  if (valueBands.size < o.minColumns - 1) return false;
  // A row with no label of its own must carry a row's worth of values. One
  // value alone, unnamed, is a chart's tick label sharing the table's baseline.
  if (label.length === 0 && valueBands.size < 2) return false;
  // Within the span those values occupy they must still dominate, or a
  // paragraph that happens to carry two numbers would qualify.
  const lo = Math.min(...valueBands);
  const hi = Math.max(...valueBands);
  const inSpan = beyondFirst.filter((run) => {
    const band = bandOf(run, bands);
    return band >= lo && band <= hi;
  });
  return valueRuns.length / inSpan.length >= o.minValueShare;
}

function buildTable(rows, bands) {
  const used = new Set();
  for (const row of rows)
    for (const run of row.runs) {
      const band = bandIn(run, bands);
      if (band >= 0) used.add(band);
    }
  const columns = [...used].sort((a, b) => a - b);
  const grid = rows.map((row) => {
    const cells = columns.map(() => "");
    for (const run of row.runs) {
      const text = run.str.trim();
      if (!text) continue;
      // Outside every kept band: the page's other content, which stays where
      // it is rather than being snapped into the nearest column.
      const at = columns.indexOf(bandIn(run, bands));
      if (at < 0) continue;
      cells[at] = cells[at] ? `${cells[at]} ${text}` : text;
    }
    return cells;
  }).filter((cells) => cells.some((cell) => cell.length > 0));
  const inside = rows.filter((row) =>
    row.runs.some((run) => bandIn(run, bands) >= 0),
  );
  const spanRows = inside.length > 0 ? inside : rows;
  const sizes = spanRows.flatMap((r) => r.runs.map((run) => run.size || 10));
  return {
    top: spanRows[0].y + Math.max(...sizes),
    bottom: spanRows.at(-1).y,
    left: Math.min(...columns.map((c) => bands[c].left)),
    right: Math.max(...columns.map((c) => bands[c].right)),
    grid,
  };
}

/**
 * The tables in one page's runs.
 * @param {{ str: string; x: number; y: number; width: number; size: number }[]} runs
 * @param {Partial<typeof DEFAULT_TABLE_OPTIONS>} [options]
 * @returns {{ top: number; bottom: number; left: number; right: number; grid: string[][] }[]}
 */
export function detectTables(runs, options = {}) {
  const o = { ...DEFAULT_TABLE_OPTIONS, ...options };
  const rows = groupRows(runs, o.rowTolerance);
  if (rows.length < o.minRows) return [];
  // Columns are read only from rows that could belong to a table — rows
  // carrying values. A heading above the table spans its whole width ("Sky
  // Protocol Key Metrics, Q1 2025 – Q1 2026" covers x 75..639, every column of
  // the metrics table under it), and projecting that span merged all six
  // columns into one band, so the table was never seen.
  const candidates = rows.filter(
    (row) =>
      row.runs.filter((run) => isValue(run.str, o.maxCellChars)).length >=
      Math.max(1, o.minColumns - 1),
  );
  if (candidates.length < o.minRows) return [];
  const pageBands = columnBands(candidates, o.columnGap);
  if (pageBands.length < o.minColumns) return [];

  const tabular = rows.map((row) => isTabular(row, pageBands, o));
  /** @type {{ from: number; to: number; count: number }[]} */
  const regions = [];
  for (let i = 0; i < rows.length; i++) {
    if (!tabular[i]) continue;
    const last = regions.at(-1);
    if (last && i - last.to <= o.maxRowsBetween + 1) {
      last.to = i;
      last.count += 1;
    } else {
      regions.push({ from: i, to: i, count: 1 });
    }
  }

  const tables = [];
  for (const region of regions) {
    if (region.count < o.minRows) continue;
    const data = rows.slice(region.from, region.to + 1);
    // Columns are read from the table's own value-carrying rows: a heading
    // above it spans the whole table and would merge every column into one.
    const wide = columnBands(
      data.filter((row) =>
        row.runs.some((run) => isValue(run.str, o.maxCellChars)),
      ),
      o.columnGap,
    );
    if (wide.length < o.minColumns) continue;
    // Keep the columns the table fills row after row. The label column is kept
    // outright: in the P&L most rows carry values with no name of their own.
    let own = wide.filter(
      (_, i) =>
        i === 0 ||
        data.filter((row) => row.runs.some((run) => bandOf(run, wide) === i))
          .length /
          data.length >=
          o.minBandOccupancy,
    );
    if (own.length < o.minColumns) continue;
    // The header is not tabular — "ACCOUNT | Q1 '25 | Q2 '25" holds no values —
    // so it sits just above the region and would be left behind, taking the
    // meaning of every column with it. It is taken only when its cells land
    // inside the columns just established; a section heading spans them
    // instead of filling them, and is left where it belongs.
    let from = region.from;
    const above = rows[region.from - 1];
    if (above) {
      const lands = new Set(
        above.runs.map((run) => bandIn(run, own)).filter((i) => i >= 0),
      );
      if (lands.size >= o.minColumns) from = region.from - 1;
    }
    {
      // An edge column whose top cell is a number rather than a name, standing
      // further off than this table's own column spacing, belongs to something
      // else sharing the page — on page 8 of the Sky report, the tick labels of
      // the chart beside the metrics table. Interior columns are never dropped,
      // so a table headed by bare years survives.
      const header = rows[from];
      const cellOf = (i) =>
        header.runs
          .filter((run) => bandIn(run, own) === i)
          .map((run) => run.str.trim())
          .join(" ");
      const gaps = own
        .slice(1)
        .map((band, i) => band.left - own[i].right)
        .sort((a, b) => a - b);
      const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
      const foreign = (i) => {
        if (i !== 0 && i !== own.length - 1) return false;
        const head = cellOf(i);
        if (head.length > 0 && !isValue(head, o.maxCellChars)) return false;
        const gap = i === 0 ? own[1].left - own[0].right : gaps.at(-1);
        return gap > o.foreignColumnGap * median;
      };
      const kept = own.filter((_, i) => !foreign(i));
      if (kept.length >= o.minColumns) own = kept;
    }
    if (own.length < o.minColumns) continue;
    if (own.length < o.narrowColumns) {
      // Judged on the data rows: the header is a row of names by definition,
      // and counting it dragged a clean balance sheet under the bar.
      const rowsWithValues = data.filter((row) =>
        row.runs.some(
          (run) => bandOf(run, own) > 0 && isValue(run.str, o.maxCellChars),
        ),
      ).length;
      const cells = data.flatMap((row) =>
        row.runs.filter((run) => bandOf(run, own) > 0),
      );
      const values = cells.filter((run) =>
        isValue(run.str, o.maxCellChars),
      ).length;
      // A two-column table is a key → value list, so every data row carries a
      // key. Rows with none are a column of prose that happens to sit beside a
      // chart's axis — page 5 of the Sky report, where paragraph fragments and
      // tick labels read as a table and the prose would have been replaced.
      const keyed = data.every((row) =>
        row.runs.some(
          (run) => bandIn(run, own) === 0 && run.str.trim().length > 0,
        ),
      );
      if (
        !keyed ||
        rowsWithValues < o.minRowsNarrow ||
        cells.length === 0 ||
        values / cells.length < o.minValueShareNarrow
      ) {
        continue;
      }
    }
    // Deliberately not merged: in this document an account name sits *between*
    // its value row and its percentage row, equidistant from both, so pairing
    // it with either is a guess — and a mis-attributed financial figure is
    // worse than a table with a label on its own line. The rows are written as
    // the geometry gives them.
    tables.push(buildTable(rows.slice(from, region.to + 1), own));
  }
  return tables;
}

/**
 * A grid as a markdown table. The first row is the header unless it holds
 * values, in which case the table is written with an empty header row —
 * inventing column names would be a lie about the document.
 * @param {string[][]} grid
 * @param {Partial<typeof DEFAULT_TABLE_OPTIONS>} [options]
 * @returns {string}
 */
export function renderTable(grid, options = {}) {
  const o = { ...DEFAULT_TABLE_OPTIONS, ...options };
  if (grid.length === 0) return "";
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (row) => [
    ...row,
    ...Array(Math.max(0, width - row.length)).fill(""),
  ];
  const escape = (cell) => cell.replace(/\|/g, "\\|");
  const headerIsValues = pad(grid[0])
    .slice(1)
    .some((cell) => isValue(cell, o.maxCellChars));
  const header = headerIsValues ? Array(width).fill("") : pad(grid[0]);
  const body = headerIsValues ? grid : grid.slice(1);
  return [
    `| ${header.map(escape).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).map(escape).join(" | ")} |`),
  ].join("\n");
}
