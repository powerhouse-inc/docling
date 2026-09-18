import { describe, expect, it } from "vitest";
import { conversionQuality, tokens } from "./quality.mjs";

const prose = "Sky Protocol delivered its strongest quarter on record in Q1 2026, powered by accelerating USDS adoption, an expanding Sky Agent Network, and a growing collateral base. ".repeat(3);

describe("conversionQuality", () => {
  it("is 1 when the conversion carries every token of the text layer", () => {
    const q = conversionQuality(prose, `## Summary\n\n${prose}`);
    expect(q.coverage).toBe(1);
    expect(q.formulas).toEqual({ total: 0, decoded: 0 });
    expect(q.images).toBe(0);
  });

  it("drops in proportion to the tokens the conversion lost", () => {
    const words = tokens(prose);
    const kept = words.slice(0, Math.floor(words.length * 0.8)).join(" ");
    const q = conversionQuality(prose, kept);
    expect(q.coverage).toBeGreaterThan(0.75);
    expect(q.coverage).toBeLessThan(0.85);
  });

  it("counts the losses the converter announces: undecoded formulas, decoded formulas, pictures", () => {
    const md = `${prose}\n\n<!-- formula-not-decoded -->\n\n$$x^2$$\n\n<!-- image -->\n\n<!-- image -->`;
    const q = conversionQuality(prose, md);
    expect(q.formulas).toEqual({ total: 2, decoded: 1 });
    expect(q.images).toBe(2);
  });

  it("refuses to judge when there is too little text — a scan, a cover", () => {
    expect(conversionQuality("", "## Scanned page\n\nlots of OCR text here").coverage).toBeNull();
    expect(conversionQuality("Sky Q1", "Sky Q1").coverage).toBeNull();
  });

  it("ignores markers, punctuation, case and single glyphs on both sides", () => {
    const q = conversionQuality("The Matrix, over F 2: connected!", "the matrix over f 2 connected <!-- image -->");
    // 'f' and '2' are single glyphs and never count; the five words all match.
    expect(tokens("The Matrix, over F 2: connected!")).toEqual(["the", "matrix", "over", "connected"]);
    expect(q.coverage).toBeNull(); // still under the 40-token floor
  });
});
