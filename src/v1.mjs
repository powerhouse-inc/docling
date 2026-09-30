// @ts-check
/**
 * A docling-serve v1 surface over this service.
 *
 * Powerhouse's workflow piece for docling (`@powerhousedao/piece-docling`)
 * speaks docling-serve's v1 API: a JSON envelope of `sources`, `options` and
 * `target`, answered with a `ConvertDocumentResponse`. This service speaks
 * `POST /convert` with the file's bytes. The two are the same job in
 * different clothes, so the routes in `server.ts` translate rather than
 * reimplement — everything here is the translation, kept pure and tested
 * apart from the server.
 *
 * What does not translate, and is not pretended away:
 *
 * - **A handful of conversion options.** Most of upstream's surface now maps
 *   onto the binding (see convert-options.mjs); the few with no equivalent —
 *   `table_mode`, `pdf_backend`, `document_timeout` — are reported in
 *   `errors[]` and drop the status to `partial_success` rather than being
 *   accepted in silence. A workflow that sets one, sees success and never
 *   learns it did nothing is the failure worth designing out.
 * - **Batching.** Upstream takes up to three sources per request; this service
 *   converts one document at a time and says so rather than dropping the rest.
 * - **Chunking as its own call.** Chunks come back with every conversion.
 *
 * What travels the other way is `powerhouse`: the measurements this service
 * makes that upstream's response shape has no field for. See `measurementsOf`.
 */

/**
 * @typedef {object} ParsedSource
 * @property {"file" | "http"} kind
 * @property {string} filename
 * @property {Buffer} [bytes]
 * @property {string} [url]
 * @property {Record<string, string>} [headers]
 */

/**
 * The last path segment of a URL, when it carries an extension — the service
 * picks the format from it, so a link ending in an id is not usable.
 * @param {string} raw
 * @returns {string | null}
 */
function filenameFromUrl(raw) {
  let path;
  try {
    path = new URL(raw).pathname;
  } catch {
    return null;
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return null;
  const name = decodeURIComponent(last);
  return name.includes(".") ? name : null;
}

/**
 * Read a v1 `/convert/source` body down to the one document it asks for.
 * @param {Record<string, any>} body
 * @returns {ParsedSource}
 */
export function parseSourceRequest(body) {
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  if (sources.length === 0) {
    throw new Error("sources is required and must hold one entry");
  }
  if (sources.length > 1) {
    throw new Error(
      `this service converts one source per request, got ${sources.length}`,
    );
  }
  const target = body?.target?.kind;
  if (target !== undefined && target !== "inbody") {
    throw new Error(
      `target.kind must be "inbody": the result comes back on this connection`,
    );
  }

  const source = sources[0] ?? {};
  if (source.kind === "file") {
    const filename = String(source.filename ?? "").trim();
    if (!filename) throw new Error("a file source needs a filename");
    const base64 = String(source.base64_string ?? "");
    if (!base64) throw new Error("a file source needs base64_string");
    return { kind: "file", filename, bytes: Buffer.from(base64, "base64") };
  }

  if (source.kind === "http") {
    const url = String(source.url ?? "").trim();
    if (!url) throw new Error("an http source needs a url");
    // The caller may name the document itself. A share link often carries its
    // name in a query parameter or not at all — drive.google.com/uc?id=… is the
    // case — and this service picks the format from the extension, so without
    // this such a link is unconvertible. Upstream has no such field; it sniffs
    // the content type instead, and ignores an unknown key.
    const given = String(source.filename ?? "").trim();
    const filename = given || filenameFromUrl(url);
    if (!filename) {
      throw new Error(
        `could not take a filename from ${url}; the format is read from the extension, so pass "filename" on the source`,
      );
    }
    const headers =
      source.headers !== null && typeof source.headers === "object"
        ? /** @type {Record<string, string>} */ (source.headers)
        : undefined;
    return { kind: "http", filename, url, headers };
  }

  throw new Error(`unsupported source kind: ${String(source.kind)}`);
}

/**
 * @param {Record<string, any> | undefined} options
 * @returns {boolean}
 */
export function wantsJson(options) {
  const formats = options?.to_formats;
  return Array.isArray(formats) && formats.includes("json");
}

/**
 * @typedef {{ option: string, detail: string }} OptionWarning
 */

/**
 * @typedef {object} Conversion
 * @property {string} markdown
 * @property {unknown[]} chunks
 * @property {string} [format]
 * @property {string} [inputName]
 * @property {{ convertMs: number, chunkMs: number }} [timings]
 * @property {string} [backend]
 * @property {string} [textSource]
 * @property {boolean} [needsOcr]
 * @property {number | null} [pages]
 * @property {unknown} [quality]
 * @property {unknown} [ocrOffer]
 * @property {unknown[]} [figures]
 * @property {unknown} [figureStats]
 * @property {unknown} [normalised]
 * @property {unknown} [ocr]
 */

/**
 * What this service measures that docling-serve's response shape has no field
 * for: how much of the document's own text survived (`quality`), where that
 * text came from (`textSource`), whether a scan is worth offering OCR for
 * (`ocrOffer`), and the figures it cut out of the pages (`figures`).
 *
 * It travels under a key of our own rather than being forced into upstream's
 * fields. A client written against docling-serve ignores an unknown key, so
 * the response stays a valid `ConvertDocumentResponse`; a client that knows
 * this service reads the block when it is there and coerces nothing when it is
 * not — which is also what it gets when it is pointed at a real docling-serve.
 */
const MEASURED = [
  "backend",
  "textSource",
  "needsOcr",
  "pages",
  "quality",
  "ocrOffer",
  "figures",
  "figureStats",
  "normalised",
  "ocr",
];

/**
 * The measured fields a conversion actually carries. Absent and null are the
 * same answer — "not measured" — and both are left out, so a reader never has
 * to tell `quality: null` apart from no quality at all.
 * @param {Conversion} conversion
 * @returns {Record<string, unknown> | undefined}
 */
function measurementsOf(conversion) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const name of MEASURED) {
    const value = /** @type {Record<string, unknown>} */ (conversion)[name];
    if (value === undefined || value === null) continue;
    // An empty figure list is "no figures", not a measurement worth carrying.
    if (Array.isArray(value) && value.length === 0) continue;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Shape a conversion as docling-serve's `ConvertDocumentResponse`.
 *
 * Only the requested formats are populated and the rest are null, which is
 * what upstream does and what the piece's `document.*_content` reads expect.
 * `json_content` carries this service's chunks: it is the nearest honest
 * equivalent of docling's document JSON, and the field is what a caller asking
 * for `json` is reaching for.
 *
 * @param {Conversion} conversion
 * @param {{ json: boolean, warnings: OptionWarning[] }} opts
 */
export function toConvertDocumentResponse(conversion, opts) {
  const { convertMs = 0, chunkMs = 0 } = conversion.timings ?? {};
  return {
    document: {
      filename: conversion.inputName ?? null,
      md_content: conversion.markdown,
      json_content: opts.json ? { chunks: conversion.chunks } : null,
      html_content: null,
      text_content: null,
      doctags_content: null,
    },
    status: opts.warnings.length > 0 ? "partial_success" : "success",
    errors: opts.warnings.map((w) => ({
      component_type: "conversion_options",
      module_name: w.option,
      error_message: w.detail,
    })),
    processing_time: (convertMs + chunkMs) / 1000,
    powerhouse: measurementsOf(conversion),
  };
}
