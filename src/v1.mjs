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
 * - **Most conversion options.** Upstream exposes some forty; this service
 *   decides OCR from the file itself and has no table mode, page range, PDF
 *   backend or enrichment flags. An option it cannot honour is reported in
 *   `errors[]` and drops the status to `partial_success` rather than being
 *   accepted in silence — a workflow that sets `table_mode`, sees success and
 *   never learns it did nothing is the failure worth designing out.
 * - **The async job routes.** `/v1/status/poll` and `/v1/result` need a store
 *   of finished conversions; `POST /convert` here holds the connection and
 *   `/progress/:id` only watches a conversion already running.
 * - **Chunking as its own call.** Chunks come back with every conversion.
 */

/** Options this service genuinely acts on. Everything else is a warning. */
const HONOURED_OPTIONS = new Set(["to_formats", "do_ocr", "force_ocr"]);

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
    const filename = filenameFromUrl(url);
    if (!filename) {
      throw new Error(
        `could not take a filename from ${url}; the format is read from the extension`,
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
 * `do_ocr` defaults true upstream, but here OCR is chosen from the file by the
 * routing ladder; only an explicit force is passed through.
 * @param {Record<string, any> | undefined} options
 * @returns {boolean}
 */
export function wantsOcr(options) {
  return options?.force_ocr === true;
}

/**
 * @typedef {{ option: string, detail: string }} OptionWarning
 */

/**
 * @param {Record<string, any> | undefined} options
 * @returns {OptionWarning[]}
 */
export function unsupportedOptionWarnings(options) {
  if (options === null || typeof options !== "object") return [];
  return Object.keys(options)
    .filter((key) => !HONOURED_OPTIONS.has(key))
    .sort()
    .map((option) => ({
      option,
      detail:
        "not supported by this conversion service and was ignored; it reads OCR, tables and layout from the file itself",
    }));
}

/**
 * @typedef {object} Conversion
 * @property {string} markdown
 * @property {unknown[]} chunks
 * @property {string} [format]
 * @property {string} [inputName]
 * @property {{ convertMs: number, chunkMs: number }} [timings]
 */

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
  };
}
