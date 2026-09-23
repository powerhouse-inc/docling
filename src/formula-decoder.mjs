// @ts-check
/**
 * Decode a cropped formula image into LaTeX.
 *
 * docling.rs cannot do this at all — a scan of its native binding finds zero
 * occurrences of formula/latex/mathml/equation, and its API is convert/chunk
 * with no enrichment hook. What it DOES give us is the detection: the layout
 * model classifies a region as a formula, and figures.mjs crops that region
 * accurately. So the only missing step is image -> LaTeX, which this module is.
 *
 * Model: breezedeus/pix2text-mfr, a TrOCR vision-encoder-decoder retrained on
 * formula images. Chosen for its licence as much as its accuracy — MIT, with no
 * commercial-use bar, which matters because we ship it to tenants.
 *
 * Why the ONNX sessions are driven by hand rather than through transformers.js:
 * that library hardcodes `decoder_model_merged.onnx` for vision-encoder-decoder
 * models, and this model (like every other permissively-licensed formula model
 * checked) publishes a plain `decoder_model.onnx`. The alternatives were an
 * unlicensed model or an AGPL one. So transformers.js is used for the two parts
 * that are genuinely fiddly — image preprocessing and tokenisation — and the
 * generate loop is ours. It is a greedy loop; there is no KV cache to use,
 * because the model ships no `decoder_with_past` variant.
 *
 * Measured on the Bitcoin whitepaper's Poisson catch-up formula: 259 ms to load
 * the sessions, 532 ms to decode 63 tokens, output correct.
 */

import { join } from "node:path";
import { access } from "node:fs/promises";

/** Repo id, and therefore the directory layout under DOCLING_RS_HOME/formula. */
export const FORMULA_MODEL_ID = "breezedeus/pix2text-mfr";

/**
 * Files the decoder needs. The two .onnx live under `onnx/` because that is
 * where transformers.js's AutoProcessor/AutoTokenizer expect a model tree to
 * be shaped, and we reuse their loader for the config files.
 */
export const FORMULA_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/encoder_model.onnx",
  "onnx/decoder_model.onnx",
];

/** Off only by explicit opt-out, so a misbehaving model can be disabled without shipping an image. */
export function formulaDecodingEnabled(env = process.env) {
  return env.CONVERT_DECODE_FORMULAS !== "0";
}

/** Per-formula ceiling. Bounds ONE formula so a pathological crop cannot hang a whole conversion; it is not a cap on how many are decoded. */
export function formulaTimeoutMs(env = process.env) {
  const n = Number(env.CONVERT_FORMULA_TIMEOUT_MS ?? 15000);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/** Root of the model tree: `<DOCLING_RS_HOME>/formula/<repo id>`. */
export function formulaModelDir(env = process.env) {
  return join(env.DOCLING_RS_HOME || ".", "formula", FORMULA_MODEL_ID);
}

/** Which of {@link FORMULA_MODEL_FILES} are absent. Empty means ready. */
export async function missingFormulaFiles(dir = formulaModelDir()) {
  const missing = [];
  for (const f of FORMULA_MODEL_FILES) {
    try {
      await access(join(dir, f));
    } catch {
      missing.push(f);
    }
  }
  return missing;
}

/**
 * Greedy argmax over the LAST position's logits.
 * @param {ArrayLike<number>} logits flattened [1, seqLen, vocab]
 * @param {number} seqLen
 * @param {number} vocab
 * @returns {number}
 */
export function argmaxLast(logits, seqLen, vocab) {
  const off = (seqLen - 1) * vocab;
  let best = 0;
  let bestValue = -Infinity;
  for (let v = 0; v < vocab; v++) {
    const x = logits[off + v];
    if (x > bestValue) {
      bestValue = x;
      best = v;
    }
  }
  return best;
}

/**
 * pix2text emits spaced-out LaTeX ("\\frac { a } { b }"). Collapse the spaces
 * that braces and carets introduce so the result reads like handwritten LaTeX
 * and, more importantly, so two runs over the same formula compare equal.
 *
 * Conservative on purpose: only the spacing braces and carets introduce is
 * collapsed. Spaces around operators are left alone — removing them buys
 * nothing and risks changing what the model actually emitted.
 * @param {string} latex
 * @returns {string}
 */
export function tidyLatex(latex) {
  return latex
    .replace(/\s+/g, " ")
    .replace(/\s*([{}^_])\s*/g, "$1")
    .replace(/\\,\s*/g, "\\,")
    .replace(/\s*\\!\s*/g, "\\!")
    .trim();
}

/** @type {{ ort: any, processor: any, tokenizer: any, encoder: any, decoder: any, generation: any } | null} */
let sessions = null;

/**
 * Load (once) the processor, tokenizer and the two ONNX sessions.
 * @param {string} dir
 */
async function load(dir) {
  if (sessions) return sessions;
  const ort = (await import("onnxruntime-node")).default;
  const { AutoProcessor, AutoTokenizer, env } =
    await import("@huggingface/transformers");
  // Local only: the container must never reach out to huggingface.co at
  // conversion time. The initContainer has already put the files in place.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = join(dir, "..", "..");

  const [processor, tokenizer, encoder, decoder] = await Promise.all([
    AutoProcessor.from_pretrained(FORMULA_MODEL_ID),
    AutoTokenizer.from_pretrained(FORMULA_MODEL_ID),
    ort.InferenceSession.create(join(dir, "onnx", "encoder_model.onnx")),
    ort.InferenceSession.create(join(dir, "onnx", "decoder_model.onnx")),
  ]);
  const generation = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(join(dir, "generation_config.json"), "utf8"),
  );
  sessions = { ort, processor, tokenizer, encoder, decoder, generation };
  return sessions;
}

/** Drop cached sessions. Tests only. */
export function resetFormulaDecoder() {
  sessions = null;
  warned = false;
}

/**
 * Whether we have already explained a failure. Formula decoding runs once per
 * formula, so an unguarded log would print hundreds of identical lines for one
 * broken install — but printing NOTHING is worse, and is how several failures
 * in this system stayed invisible for months. One line, then silence.
 */
let warned = false;

/** @param {unknown} error */
function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn(
    `[formula] decoding unavailable, formulas will keep the placeholder: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Decode one cropped formula PNG.
 *
 * Returns null for every failure — missing model, load error, timeout, empty
 * output. The caller then keeps the existing placeholder, so a conversion never
 * fails because a formula would not decode.
 *
 * @param {Buffer} png
 * @param {{ dir?: string, timeoutMs?: number, maxTokens?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function decodeFormula(png, options = {}) {
  const dir = options.dir ?? formulaModelDir();
  const timeoutMs = options.timeoutMs ?? formulaTimeoutMs();
  const maxTokens = options.maxTokens ?? 256;
  const deadline = Date.now() + timeoutMs;

  try {
    // Check the files BEFORE touching transformers.js. Its `env.localModelPath`
    // is global mutable state and a failed load against a bad path poisons its
    // internal config cache for the rest of the process — later, correct calls
    // then fail with an unrelated `tokenizer_class` error. Refusing to load a
    // model that isn't there avoids that entirely, and is cheaper than throwing
    // once per formula.
    const missing = await missingFormulaFiles(dir);
    if (missing.length > 0) {
      warnOnce(new Error(`model files missing: ${missing.join(", ")}`));
      return null;
    }
    const s = await load(dir);
    const { RawImage } = await import("@huggingface/transformers");
    const image = await RawImage.fromBlob(new Blob([new Uint8Array(png)]));
    const { pixel_values } = await s.processor(image);
    const { last_hidden_state } = await s.encoder.run({
      pixel_values: new s.ort.Tensor(
        "float32",
        pixel_values.data,
        pixel_values.dims,
      ),
    });

    const bos =
      s.generation.decoder_start_token_id ?? s.generation.bos_token_id ?? 0;
    const eos = s.generation.eos_token_id ?? 2;
    const ids = [bos];
    for (let step = 0; step < maxTokens; step++) {
      if (Date.now() > deadline) return null;
      const out = await s.decoder.run({
        input_ids: new s.ort.Tensor(
          "int64",
          BigInt64Array.from(ids.map(BigInt)),
          [1, ids.length],
        ),
        encoder_hidden_states: last_hidden_state,
      });
      const next = argmaxLast(
        out.logits.data,
        out.logits.dims[1],
        out.logits.dims[2],
      );
      if (next === eos) break;
      ids.push(next);
    }
    if (ids.length <= 1) return null;
    const latex = tidyLatex(
      s.tokenizer.decode(ids.slice(1), { skip_special_tokens: true }),
    );
    return latex.length > 0 ? latex : null;
  } catch (error) {
    warnOnce(error);
    return null;
  }
}
