import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  altFor,
  applyBudget,
  interiorRows,
  FORMULA_PLACEHOLDER,
  formulaRegions,
  pictureFigures,
  readingOrder,
  replacePlaceholder,
  toPixels,
  type Figure,
} from "./figures.mjs";

// The paper (2609.17533v1), as docling's JSON, pictures shrunk to 1×1 PNGs.
const paper = JSON.parse(
  readFileSync(
    new URL("./fixtures/paper.docling.json", import.meta.url),
    "utf8",
  ),
) as unknown;

describe("readingOrder", () => {
  it("follows body.children, descending into lists but not into pictures", () => {
    const order = readingOrder(paper) as { label: string }[];
    expect(order.length).toBeGreaterThan(250);
    expect(order.filter((i) => i.label === "picture")).toHaveLength(3);
    expect(order.some((i) => i.label === "list_item")).toBe(true);
    // Captions hang off their picture, not off the body: they are not reading-order items of their own.
    expect(order.filter((i) => i.label === "caption")).toHaveLength(0);
  });
});

describe("formulaRegions", () => {
  it("locates 70 of the paper's 79 formulas by the gap between their neighbours; 7 cross a page, 2 have their next item above the previous", () => {
    const { regions, total, skipped } = formulaRegions(paper);
    expect(total).toBe(79);
    expect(skipped).toBe(9);
    expect(regions).toHaveLength(70);
    for (const r of regions) {
      expect(r.box.t).toBeGreaterThan(r.box.b);
      expect(r.box.r).toBeGreaterThan(r.box.l);
      expect(r.page).toBeGreaterThan(0);
    }
    // indices are the n-th placeholder in the markdown: strictly increasing, gaps where skipped
    const idx = regions.map((r) => r.placeholderIndex);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(idx.at(-1)).toBeLessThan(79);
  });

  it("splits a gap shared by consecutive formulas evenly", () => {
    const prov = (page: number, t: number, b: number) => [
      { page_no: page, bbox: { l: 100, t, r: 400, b }, charspan: [0, 1] },
    ];
    const doc = {
      body: {
        children: [
          { $ref: "#/texts/0" },
          { $ref: "#/texts/1" },
          { $ref: "#/texts/2" },
          { $ref: "#/texts/3" },
        ],
      },
      texts: [
        {
          self_ref: "#/texts/0",
          label: "text",
          prov: prov(1, 700, 600),
          text: "before",
        },
        {
          self_ref: "#/texts/1",
          label: "text",
          prov: [],
          text: FORMULA_PLACEHOLDER,
        },
        {
          self_ref: "#/texts/2",
          label: "text",
          prov: [],
          text: FORMULA_PLACEHOLDER,
        },
        {
          self_ref: "#/texts/3",
          label: "text",
          prov: prov(1, 500, 400),
          text: "after",
        },
      ],
      pictures: [],
      tables: [],
      groups: [],
    };
    const { regions } = formulaRegions(doc);
    expect(regions).toHaveLength(2);
    expect(regions[0].box.t).toBeCloseTo(604, 0); // 600 + pad
    expect(regions[0].box.b).toBeCloseTo(546, 0); // 600 − 50 − pad
    expect(regions[1].box.t).toBeCloseTo(554, 0);
    expect(regions[1].box.b).toBeCloseTo(496, 0);
  });
});

describe("pictureFigures", () => {
  it("returns the embedded PNG, page, box and caption for each picture, indexed by placeholder", () => {
    const pics = pictureFigures(paper);
    expect(pics).toHaveLength(3);
    expect(pics.map((p) => p.placeholderIndex)).toEqual([0, 1, 2]);
    expect(pics[0].page).toBe(8);
    expect(pics[0].png.startsWith("iVBOR")).toBe(true);
    expect(pics[0].caption.length).toBeGreaterThan(0);
    expect(pics[0].box).not.toBeNull();
  });
});

describe("toPixels", () => {
  it("converts a BOTTOMLEFT point box to a TOPLEFT pixel rectangle — validated against a real crop", () => {
    // texts/5 on page 1 of the paper, rendered at 200 dpi: the crop that read correctly.
    expect(
      toPixels(
        { l: 133.88, t: 293.91, r: 476.93, b: 232.03 },
        { width: 612, height: 792 },
        200,
      ),
    ).toEqual({
      left: 371,
      top: 1383,
      width: 954,
      height: 173,
    });
  });
  it("clamps to the page and never returns an empty rectangle", () => {
    expect(
      toPixels(
        { l: -10, t: 800, r: 700, b: 790 },
        { width: 612, height: 792 },
        72,
      ),
    ).toEqual({ left: 0, top: 0, width: 612, height: 2 });
  });
});

describe("replacePlaceholder", () => {
  it("replaces only the n-th occurrence", () => {
    const md = `a\n\n${FORMULA_PLACEHOLDER}\n\nb\n\n${FORMULA_PLACEHOLDER}\n\nc`;
    expect(replacePlaceholder(md, FORMULA_PLACEHOLDER, 1, "![f](x)")).toBe(
      `a\n\n${FORMULA_PLACEHOLDER}\n\nb\n\n![f](x)\n\nc`,
    );
    expect(replacePlaceholder(md, FORMULA_PLACEHOLDER, 5, "![f](x)")).toBe(md);
  });
});

describe("interiorRows", () => {
  // 0 = blank row, 5 = inked row. A sliver of the line above (rows 0–2), the
  // formula (rows 8–15), a sliver of the line below (rows 20–22).
  const profile = (spec: string) =>
    spec.split("").map((c) => (c === "#" ? 5 : 0));
  it("keeps the band that touches neither edge and drops the slivers", () => {
    expect(interiorRows(profile("###.....########....###"))).toEqual({
      top: 6,
      height: 12,
    });
  });
  it("keeps everything when the only band touches an edge (a formula filling the crop)", () => {
    expect(interiorRows(profile("###############.......")).height).toBe(22);
    expect(interiorRows(profile("......................"))).toEqual({
      top: 0,
      height: 22,
    });
  });
  it("keeps a two-line formula as one band when its lines are closer than minGap", () => {
    expect(
      interiorRows(profile("##....####.####....##"), { minGap: 3 }),
    ).toEqual({ top: 4, height: 13 });
  });
});

describe("altFor", () => {
  it("names what the reader is looking at, and that a formula is not decoded", () => {
    expect(altFor({ kind: "formula", page: 7, placeholderIndex: 11 })).toBe(
      "formula 12, page 7 — not decoded",
    );
    expect(
      altFor({
        kind: "picture",
        page: 8,
        placeholderIndex: 0,
        caption: "Figure 1: The flip graph",
      }),
    ).toBe("figure 1, page 8 — Figure 1: The flip graph");
  });
});

describe("applyBudget", () => {
  const fig = (kind: Figure["kind"], n: number, size: number): Figure => ({
    id: `${kind}-${n}`,
    kind,
    page: 1,
    box: null,
    placeholderIndex: n,
    alt: "",
    mimeType: "image/png",
    width: 1,
    height: 1,
    bytesBase64: "x".repeat(size),
  });
  it("keeps everything under the budget", () => {
    const figures = [fig("picture", 0, 100), fig("formula", 0, 50)];
    expect(applyBudget(figures, 1_000)).toEqual({ kept: figures, dropped: 0 });
  });
  it("drops formulas first, from the end, then pictures", () => {
    const figures = [
      fig("picture", 0, 100),
      fig("formula", 0, 50),
      fig("formula", 1, 50),
      fig("picture", 1, 100),
    ];
    const { kept, dropped } = applyBudget(figures, 210);
    expect(dropped).toBe(2);
    expect(kept.map((f) => f.id)).toEqual(["picture-0", "picture-1"]);
  });
});
