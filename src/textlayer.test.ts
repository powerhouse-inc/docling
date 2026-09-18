import { describe, expect, it } from "vitest";
import {
  absorbFigureText,
  bodySize,
  documentToBlocks,
  documentToMarkdown,
  insertFigurePlaceholders,
  linesFromRuns,
  type Run,
} from "./textlayer.mjs";

// Geometry lifted from the Sky Ecosystem Q1 2026 report as pdf.js reads it:
// body 20 pt, 26 px between lines, 52 px between paragraphs, headings 30/60.
const run = (
  str: string,
  size: number,
  x: number,
  y: number,
  width: number,
  eol = false,
): Run => ({
  str,
  size,
  x,
  y,
  width,
  eol,
});
const eol = (size: number, x: number, y: number): Run =>
  run("", size, x, y, 0, true);

const page3: Run[] = [
  run("Executive Summary", 60, 55, 953, 524),
  eol(20, 55, 856),
  run(
    "Sky Protocol delivered its strongest quarter on record in Q1 2026,",
    20,
    55,
    856,
    611,
    true,
  ),
  run(
    "powered by accelerating USDS adoption, an expanding Sky Agent",
    20,
    55,
    830,
    611,
    true,
  ),
  run("Network, and a growing collateral base.", 20, 55, 804, 347),
  eol(30, 75, 719),
  run("Summary", 30, 75, 719, 126),
  eol(20, 98, 673),
  run("Gross Protocol Revenue: $123.79M, up", 20, 98, 673, 381),
  run(" ", 20, 479, 673, 1),
  run("28.9%", 20, 491, 673, 53),
  run(" ", 20, 544, 673, 1),
  run("YoY", 20, 557, 673, 33),
  run(
    "$96.01M in Q1 2025 and 56.8% QoQ from $78.97M in Q4",
    20,
    98,
    647,
    548,
    true,
  ),
  run(
    "2025. The highest quarterly revenue in protocol history.",
    20,
    98,
    621,
    485,
  ),
  eol(20, 98, 579),
  run(
    "Net Protocol Surplus: $46.04M, compared to a net loss of",
    20,
    98,
    579,
    548,
    true,
  ),
  run("$13.51M in Q1 2025.", 20, 98, 553, 200),
];

describe("linesFromRuns", () => {
  it("joins runs on one line, glueing a font-change split without a space", () => {
    const lines = linesFromRuns([
      run("Protocol", 20, 55, 830, 74),
      run(" ", 20, 129, 830, 1),
      run("Revenue", 20, 143, 830, 77),
      run("$123.79M,", 20, 320, 830, 88),
      run("ending", 20, 408.5, 830, 62), // 0.5 px after the comma: the same word run
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Protocol Revenue $123.79M,ending");
  });

  it("starts a new line when y changes, and drops the empty EOL markers", () => {
    const lines = linesFromRuns(page3);
    expect(lines.map((l) => l.text)).toEqual([
      "Executive Summary",
      "Sky Protocol delivered its strongest quarter on record in Q1 2026,",
      "powered by accelerating USDS adoption, an expanding Sky Agent",
      "Network, and a growing collateral base.",
      "Summary",
      "Gross Protocol Revenue: $123.79M, up 28.9% YoY",
      "$96.01M in Q1 2025 and 56.8% QoQ from $78.97M in Q4",
      "2025. The highest quarterly revenue in protocol history.",
      "Net Protocol Surplus: $46.04M, compared to a net loss of",
      "$13.51M in Q1 2025.",
    ]);
  });
});

describe("bodySize", () => {
  it("is the size most characters are set in, not the most frequent line", () => {
    const lines = linesFromRuns(page3);
    expect(bodySize(lines)).toBe(20);
  });
});

describe("documentToMarkdown", () => {
  it("promotes 3× lines to a title, 1.5× to a heading, and reflows paragraphs", () => {
    const { markdown, headings, bodySize: body } = documentToMarkdown([page3]);
    expect(body).toBe(20);
    expect(headings).toBe(2);
    expect(markdown).toBe(
      [
        "# Executive Summary",
        "Sky Protocol delivered its strongest quarter on record in Q1 2026, powered by accelerating USDS adoption, an expanding Sky Agent Network, and a growing collateral base.",
        "## Summary",
        "Gross Protocol Revenue: $123.79M, up 28.9% YoY $96.01M in Q1 2025 and 56.8% QoQ from $78.97M in Q4 2025. The highest quarterly revenue in protocol history.",
        "Net Protocol Surplus: $46.04M, compared to a net loss of $13.51M in Q1 2025.",
      ].join("\n\n"),
    );
  });

  it("decides the body size once for the document, so a chart-only page does not grow headings", () => {
    const chart: Run[] = [
      run("Gross Protocol Revenue ($M)", 14, 766, 789, 179),
      run("$140M", 12, 748, 756, 36),
      run("$120M", 12, 748, 718, 36),
    ];
    const { markdown } = documentToMarkdown([page3, chart]);
    expect(markdown).not.toMatch(/^#+ Gross Protocol Revenue \(\$M\)/m);
    expect(markdown).toContain("Gross Protocol Revenue ($M)");
  });

  it("separates columns — a line higher on the page than the last starts a new block — and does not invent headings from 1 pt", () => {
    // Page 2 of the report: eight product cards in columns, each a 15 pt label
    // over 14 pt text. 15/14 is bold, not bigger; the label stays in its
    // paragraph. The jump back up the page to the next column is a real break.
    const twoColumns: Run[] = [
      run("Sky Protocol", 15, 192, 191, 86),
      run("The underlying protocol", 14, 192, 175, 234, true),
      run("powering Sky.", 14, 192, 161, 205),
      run("Sky Stablecoins", 15, 512, 191, 109),
      run("All of the stablecoins.", 14, 512, 175, 240),
    ];
    const { markdown } = documentToMarkdown([twoColumns]);
    expect(markdown.split("\n\n")).toEqual([
      "Sky Protocol The underlying protocol powering Sky.",
      "Sky Stablecoins All of the stablecoins.",
    ]);
  });

  it("keeps a heading that wraps onto two lines as one heading", () => {
    const wrapped: Run[] = [
      run("Protocol Financials: Revenue &", 60, 55, 953, 900, true),
      run("Surplus", 60, 55, 883, 200),
      run(
        "Q1 2026 broke every revenue record in protocol history. Gross",
        20,
        55,
        856,
        611,
        true,
      ),
      run(
        "Protocol Revenue reached $123.79M, ending three consecutive",
        20,
        55,
        830,
        611,
        true,
      ),
      run("quarters of declining revenue.", 20, 55, 804, 300),
    ];
    const { markdown } = documentToMarkdown([wrapped]);
    expect(markdown).toBe(
      "# Protocol Financials: Revenue & Surplus\n\nQ1 2026 broke every revenue record in protocol history. Gross Protocol Revenue reached $123.79M, ending three consecutive quarters of declining revenue.",
    );
  });

  it("keeps the flat text alongside, for the garble check and the coverage score", () => {
    const { text } = documentToMarkdown([page3]);
    expect(text).toContain("Executive Summary");
    expect(text).not.toContain("#");
  });
});

describe("insertFigurePlaceholders", () => {
  // Page 5 of the report: a paragraph column on the left, a chart on the right
  // whose top (827 pt) is above the second paragraph's top.
  const page5: Run[] = [
    run(
      "Q1 2026 broke every revenue record in protocol history. Gross",
      20,
      55,
      856,
      611,
      true,
    ),
    run(
      "Protocol Revenue reached $123.79M, ending three consecutive",
      20,
      55,
      830,
      611,
    ),
    run(
      "Net Protocol Revenue margin expanded to 49.06%, up from 30.24%",
      20,
      55,
      674,
      611,
      true,
    ),
    run("in Q4 2025.", 20, 55, 648, 102),
    run(
      "Net Protocol Surplus of $46.04M marks the fourth consecutive",
      20,
      55,
      596,
      611,
      true,
    ),
    run("positive quarter.", 20, 55, 570, 225),
  ];
  const chart = {
    id: "picture-1",
    kind: "picture" as const,
    page: 1,
    box: { l: 747, t: 827, r: 1410, b: 560 },
  };
  const ph = {
    picture: "<!-- image -->",
    formula: "<!-- formula-not-decoded -->",
  };

  it("places a figure before the first block that starts below its top", () => {
    const { pages } = documentToBlocks([page5]);
    const { markdown, placed, unplaced } = insertFigurePlaceholders(
      pages,
      [chart],
      ph,
    );
    expect(markdown.split("\n\n")).toEqual([
      "Q1 2026 broke every revenue record in protocol history. Gross Protocol Revenue reached $123.79M, ending three consecutive",
      "<!-- image -->",
      "Net Protocol Revenue margin expanded to 49.06%, up from 30.24% in Q4 2025.",
      "Net Protocol Surplus of $46.04M marks the fourth consecutive positive quarter.",
    ]);
    expect(placed).toEqual([chart]);
    expect(unplaced).toEqual([]);
  });

  it("appends a figure below all text, and reports one without a box as unplaced", () => {
    const { pages } = documentToBlocks([page5]);
    const low = {
      ...chart,
      id: "picture-2",
      box: { l: 55, t: 300, r: 600, b: 100 },
    };
    const boxless = { ...chart, id: "picture-3", box: null };
    const { markdown, placed, unplaced } = insertFigurePlaceholders(
      pages,
      [low, boxless],
      ph,
    );
    expect(markdown.endsWith("positive quarter.\n\n<!-- image -->")).toBe(true);
    expect(placed.map((f) => f.id)).toEqual(["picture-2"]);
    expect(unplaced.map((f) => f.id)).toEqual(["picture-3"]);
  });

  it("orders several figures on one page top to bottom, which is the order of their placeholders", () => {
    const { pages } = documentToBlocks([page5]);
    const top = {
      ...chart,
      id: "f-top",
      kind: "formula" as const,
      box: { l: 55, t: 900, r: 600, b: 880 },
    };
    const mid = {
      ...chart,
      id: "p-mid",
      box: { l: 55, t: 700, r: 600, b: 690 },
    };
    const { markdown, placed } = insertFigurePlaceholders(
      pages,
      [mid, top],
      ph,
    );
    expect(placed.map((f) => f.id)).toEqual(["f-top", "p-mid"]);
    expect(markdown.indexOf("<!-- formula-not-decoded -->")).toBeLessThan(
      markdown.indexOf("<!-- image -->"),
    );
  });

  it("puts a figure on a page with no text at the end, in page order", () => {
    const { pages } = documentToBlocks([page5]);
    const later = { ...chart, id: "p-later", page: 3 };
    const { markdown, placed } = insertFigurePlaceholders(pages, [later], ph);
    expect(markdown.endsWith("<!-- image -->")).toBe(true);
    expect(placed.map((f) => f.id)).toEqual(["p-later"]);
  });
});

describe("absorbFigureText", () => {
  // Page 7 of the Sky report as pdf.js reads it: a prose column above the
  // chart, then the chart's own title, legend, axis ticks, bar labels and
  // source note — all live text inside docling's picture box, which is why
  // they reached the source twice. Geometry measured, not invented.
  const box = { l: 52.5, t: 611.72, r: 948.75, b: 82.27 };
  const page7: Run[] = [
    run(
      "Q1 saw the balance sheet expand by $2.97B in a single quarter, reaching $13.03B in total Protocol Collateral, concentrated in two categories.",
      20,
      55,
      726,
      880,
      true,
    ),
    run("Protocol Collateral Composition, Q1 2025 – Q1 2026", 30, 75, 560, 700),
    run("Sky Agent Vaults", 18, 94, 523, 120),
    run("PSM Vaults", 18, 232, 523, 80),
    run("Other", 18, 335, 523, 40),
    run("$14B", 16, 80, 491, 40, true),
    run("$12B", 16, 81, 442, 40, true),
    run("$615.44M", 16, 171, 158, 70, true),
    run(
      "Source: Sky Ecosystem Financial Dashboard; data as of March 31, 2026.",
      16,
      75,
      106,
      600,
      true,
    ),
  ];

  it("takes the chart's own text and leaves the page's prose", () => {
    const { pages } = documentToBlocks([page7]);
    const { kept, caption, labels } = absorbFigureText(pages[0].blocks, box);
    expect(caption).toBe("Protocol Collateral Composition, Q1 2025 – Q1 2026");
    expect(labels).toContain("Sky Agent Vaults PSM Vaults Other");
    expect(labels).toContain("$615.44M");
    expect(labels).toContain(
      "Source: Sky Ecosystem Financial Dashboard; data as of March 31, 2026.",
    );
    // the paragraph above the chart is the document's, not the figure's
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toContain("balance sheet expand");
  });

  it("refuses a paragraph inside the box, so a page background cannot eat the page", () => {
    const whole = { l: 0, t: 1080, r: 1920, b: 0 };
    const { pages } = documentToBlocks([page7]);
    const { kept, labels } = absorbFigureText(pages[0].blocks, whole);
    expect(kept.map((b) => b.text)).toEqual([
      expect.stringContaining("balance sheet expand"),
    ]);
    expect(labels.join(" ")).not.toContain("balance sheet expand");
  });

  it("takes nothing when the box holds no text", () => {
    const { pages } = documentToBlocks([page7]);
    const empty = { l: 1500, t: 1000, r: 1900, b: 900 };
    const { kept, caption, labels } = absorbFigureText(pages[0].blocks, empty);
    expect(caption).toBeNull();
    expect(labels).toEqual([]);
    expect(kept).toBe(pages[0].blocks);
  });

  it("writes the figure's text under its image and captions the figure", () => {
    const { pages } = documentToBlocks([page7]);
    const chart7 = {
      id: "picture-1",
      kind: "picture" as const,
      page: 1,
      box,
    };
    const { markdown, placed } = insertFigurePlaceholders(pages, [chart7], {
      picture: "<!-- image -->",
      formula: "<!-- formula-not-decoded -->",
    });
    expect(placed[0].caption).toBe(
      "Protocol Collateral Composition, Q1 2025 – Q1 2026",
    );
    expect(markdown).toContain(
      "<!-- image -->\n\n*Protocol Collateral Composition, Q1 2025 – Q1 2026*",
    );
    expect(markdown).toContain("*Figure text: ");
    // the tick label is the figure's now, not a paragraph of the document
    expect(markdown).not.toMatch(/^\$14B$/m);
  });
});
