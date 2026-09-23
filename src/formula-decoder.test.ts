import { describe, it, expect } from "vitest";
import {
  argmaxLast,
  decodeFormula,
  replacementOrder,
  resetFormulaDecoder,
  formulaDecodingEnabled,
  formulaModelDir,
  formulaTimeoutMs,
  missingFormulaFiles,
  tidyLatex,
  FORMULA_MODEL_FILES,
} from "./formula-decoder.mjs";

describe("formulaDecodingEnabled", () => {
  // On by default: the feature is meant to be the normal path, and the switch
  // exists so a misbehaving model can be turned off without shipping an image.
  it("is on unless explicitly disabled", () => {
    expect(formulaDecodingEnabled({})).toBe(true);
    expect(formulaDecodingEnabled({ CONVERT_DECODE_FORMULAS: "1" })).toBe(true);
    expect(formulaDecodingEnabled({ CONVERT_DECODE_FORMULAS: "0" })).toBe(
      false,
    );
  });
});

describe("formulaTimeoutMs", () => {
  it("defaults to 60s and ignores nonsense", () => {
    // 60s, not 15s: measured on the Robot node the same formulas take 6.6s,
    // 9.8s and 24s. The original 15s was a laptop number and silently dropped
    // the longest formula of a three-formula document.
    expect(formulaTimeoutMs({})).toBe(60000);
    expect(formulaTimeoutMs({ CONVERT_FORMULA_TIMEOUT_MS: "500" })).toBe(500);
    for (const bad of ["", "abc", "0", "-5"]) {
      expect(formulaTimeoutMs({ CONVERT_FORMULA_TIMEOUT_MS: bad })).toBe(60000);
    }
  });
});

describe("formulaModelDir", () => {
  it("hangs off DOCLING_RS_HOME, beside the docling.rs models", () => {
    expect(formulaModelDir({ DOCLING_RS_HOME: "/models" })).toBe(
      "/models/formula/breezedeus/pix2text-mfr",
    );
  });
});

describe("argmaxLast", () => {
  // The generate loop reads the LAST position's row, not the first — getting
  // this wrong yields a plausible-looking but constant token.
  it("picks the largest logit of the final position", () => {
    // 2 positions, vocab 3. Last row is [0.1, 0.2, 9].
    const logits = [5, 0, 0, 0.1, 0.2, 9];
    expect(argmaxLast(logits, 2, 3)).toBe(2);
  });
  it("reads position 1 of 1 correctly", () => {
    expect(argmaxLast([0.1, 7, 0.3], 1, 3)).toBe(1);
  });
});

describe("tidyLatex", () => {
  // pix2text emits spaced-out LaTeX; collapsing it keeps the output readable
  // AND makes two decodes of the same formula compare equal.
  it("collapses the spacing around braces and carets", () => {
    expect(tidyLatex("\\frac { a } { b }")).toBe("\\frac{a}{b}");
    expect(tidyLatex("x ^ { 2 }")).toBe("x^{2}");
    expect(tidyLatex("\\sum _ { k = 0 } ^ { z }")).toBe("\\sum_{k = 0}^{z}");
  });
  // Deliberately conservative: only the spacing braces and carets introduce is
  // collapsed. Spaces around operators are LEFT ALONE -- stripping them buys
  // nothing and risks changing content the model actually emitted.
  it("leaves spacing around operators alone", () => {
    expect(tidyLatex("a = b")).toBe("a = b");
    expect(tidyLatex("x + y")).toBe("x + y");
  });
  it("is idempotent", () => {
    const once = tidyLatex("\\frac { a } { b }");
    expect(tidyLatex(once)).toBe(once);
  });
});

describe("missingFormulaFiles", () => {
  it("reports every file as missing for an empty directory", async () => {
    const missing = await missingFormulaFiles("/nonexistent-formula-model-dir");
    expect(missing).toEqual(FORMULA_MODEL_FILES);
  });
  it("names both ONNX files under onnx/, which is where transformers.js looks", () => {
    expect(FORMULA_MODEL_FILES).toContain("onnx/encoder_model.onnx");
    expect(FORMULA_MODEL_FILES).toContain("onnx/decoder_model.onnx");
  });
});

describe("decodeFormula failure paths", () => {
  // Every one of these must yield null rather than throw: a formula that will
  // not decode keeps its placeholder, and the CONVERSION still succeeds.
  it("returns null, without throwing, when the model is not installed", async () => {
    resetFormulaDecoder();
    const png = Buffer.from("not a png");
    await expect(
      decodeFormula(png, { dir: "/nonexistent-formula-model-dir" }),
    ).resolves.toBeNull();
  });

  // Regression: decodeFormula used to hand a bad path straight to
  // transformers.js, whose `env.localModelPath` is global mutable state. One
  // failed load poisoned its config cache for the rest of the process, so every
  // LATER call — with a perfectly good path — died on an unrelated
  // `tokenizer_class` error. Checking the files first keeps the failure local.
  it("a failed attempt does not poison later ones", async () => {
    resetFormulaDecoder();
    await decodeFormula(Buffer.from("x"), { dir: "/nonexistent-a" });
    await decodeFormula(Buffer.from("x"), { dir: "/nonexistent-b" });
    // Still merely null, not a different error, and the module is still usable.
    await expect(
      decodeFormula(Buffer.from("x"), { dir: "/nonexistent-c" }),
    ).resolves.toBeNull();
  });
});

describe("replacementOrder", () => {
  // replacePlaceholder finds the n-th REMAINING occurrence, so each
  // substitution shifts every later placeholder down by one. Replacing in
  // ascending order silently mis-targets everything after the first -- on a
  // three-formula document that showed up as a formula decoding correctly and
  // then landing nowhere.
  it("returns figures highest placeholder index first", () => {
    const figures = [
      { placeholderIndex: 0, id: "a" },
      { placeholderIndex: 2, id: "c" },
      { placeholderIndex: 1, id: "b" },
    ];
    expect(replacementOrder(figures).map((f) => f.id)).toEqual(["c", "b", "a"]);
  });
  it("does not mutate its input", () => {
    const figures = [{ placeholderIndex: 0 }, { placeholderIndex: 1 }];
    replacementOrder(figures);
    expect(figures.map((f) => f.placeholderIndex)).toEqual([0, 1]);
  });
});
