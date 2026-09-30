// @ts-check
/**
 * The conversion options this service accepts, and how they reach docling.rs.
 *
 * The binding exposes about thirty knobs — OCR, layout, tables, enrichment,
 * ASR, VLM — and until now the service passed through exactly one (`?ocr=1`).
 * These are the two front doors onto that surface: query parameters on
 * `POST /convert`, and docling-serve's `options` block on
 * `POST /v1/convert/source`, whose names differ and are translated here.
 *
 * Two rules the rest of the server depends on:
 *
 * - **Conversion options and chunker options are separate bags.** The binding
 *   takes `ConvertOptions` and `ChunkOptions` and they share no fields.
 * - **A request carrying conversion options cannot use the warm pipeline.**
 *   The pipeline ignores per-call options — measured, and already the reason
 *   the OCR path bypasses it — so `hasConvertOptions` exists for the server to
 *   ask before choosing a path.
 */

/**
 * @typedef {Record<string, string | number | boolean>} DoclingConvertOptions
 * @typedef {Record<string, string | number | boolean>} DoclingChunkOptions
 * @typedef {{ option: string, detail: string }} OptionWarning
 * @typedef {Record<string, string>} ServiceOptions
 * @typedef {{ convert: DoclingConvertOptions, chunk: DoclingChunkOptions, service: ServiceOptions, warnings: OptionWarning[] }} ParsedOptions
 */

// `service` is the third bag: /convert's own query parameters, which are not
// ConvertOptions and never reach the binding. Figures are the case — this
// service renders them itself, in a pass docling.rs knows nothing about.

/** Query parameters that map straight onto a ConvertOptions boolean. */
const QUERY_BOOLEANS = [
  "skipOcr",
  "forceFullPageOcr",
  "headingHierarchy",
  "noTextPanels",
  "skipEmptyCells",
  "compactTables",
  "listAttachments",
  "doPictureClassification",
  "doCodeEnrichment",
  "doFormulaEnrichment",
  "fetchImages",
  "strict",
];

/** …onto a string. */
const QUERY_STRINGS = [
  "ocrLang",
  "ocrMode",
  "ebcdicLayout",
  "pages",
  "pipeline",
  "imageMode",
  "pageBreakPlaceholder",
  "asrModel",
  "asrLang",
  "vlmEndpoint",
  "vlmModel",
  "vlmApiKey",
  "vlmPrompt",
];

/** …onto a number. */
const QUERY_NUMBERS = ["ocrScale", "videoFrames", "vlmMaxTokens"];

/** The chunker's own settings, which never reach ConvertOptions. */
const CHUNK_BOOLEANS = ["mergePeers"];
const CHUNK_STRINGS = ["chunker", "tokenizer"];
const CHUNK_NUMBERS = ["maxTokens"];

/**
 * `1`/`true`/`yes`/`on` are true, `0`/`false`/`no`/`off` are false.
 * @param {string} raw
 * @returns {boolean}
 */
function asBoolean(raw) {
  return !["0", "false", "no", "off", ""].includes(raw.trim().toLowerCase());
}

/**
 * @param {string} name
 * @param {string} raw
 * @returns {number}
 */
function asNumber(name, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
}

/**
 * Read `POST /convert`'s query parameters as docling options.
 * @param {URLSearchParams} query
 * @returns {ParsedOptions}
 */
export function doclingOptionsFromQuery(query) {
  /** @type {DoclingConvertOptions} */
  const convert = {};
  /** @type {DoclingChunkOptions} */
  const chunk = {};

  // The original switch, kept meaning exactly what it meant before.
  if (query.has("ocr") && asBoolean(query.get("ocr") ?? "")) {
    convert.forceFullPageOcr = true;
  }

  for (const name of QUERY_BOOLEANS) {
    const raw = query.get(name);
    if (raw !== null) convert[name] = asBoolean(raw);
  }
  for (const name of QUERY_STRINGS) {
    const raw = query.get(name);
    if (raw !== null && raw !== "") convert[name] = raw;
  }
  for (const name of QUERY_NUMBERS) {
    const raw = query.get(name);
    if (raw !== null) convert[name] = asNumber(name, raw);
  }

  for (const name of CHUNK_BOOLEANS) {
    const raw = query.get(name);
    if (raw !== null) chunk[name] = asBoolean(raw);
  }
  for (const name of CHUNK_STRINGS) {
    const raw = query.get(name);
    if (raw !== null && raw !== "") chunk[name] = raw;
  }
  for (const name of CHUNK_NUMBERS) {
    const raw = query.get(name);
    if (raw !== null) chunk[name] = asNumber(name, raw);
  }

  return { convert, chunk, service: {}, warnings: [] };
}

/** docling-serve option names this service handles outside the mapping. */
const V1_HANDLED_ELSEWHERE = new Set(["to_formats", "from_formats"]);

/**
 * Options this service has no field for, but whose listed value describes
 * what it already does. Asking for it costs the caller nothing, so it is not
 * worth a warning — and warning anyway is not a harmless extra: the piece
 * sends `table_mode` and `do_table_structure` on every request, because both
 * are required props with exactly these defaults. Reporting them turned every
 * single conversion into `partial_success` and buried the warnings that mean
 * something.
 *
 * The other value of the same option is a genuine request that will not be
 * honoured, and still warns. docling.rs always recovers table structure, and
 * does it accurately; it has no faster, rougher mode to drop to.
 */
const V1_INERT_VALUES = new Map(
  /** @type {[string, unknown][]} */ ([
    ["table_mode", "accurate"],
    ["do_table_structure", true],
  ]),
);

/**
 * Translate docling-serve's `options` block onto the binding's names.
 * @param {Record<string, any> | undefined} options
 * @returns {ParsedOptions}
 */
export function doclingOptionsFromV1(options) {
  /** @type {DoclingConvertOptions} */
  const convert = {};
  /** @type {OptionWarning[]} */
  const warnings = [];
  /** @type {ServiceOptions} */
  const service = {};
  if (options === null || typeof options !== "object") {
    return { convert, chunk: {}, service, warnings };
  }

  for (const [key, value] of Object.entries(options)) {
    if (V1_HANDLED_ELSEWHERE.has(key)) continue;
    if (V1_INERT_VALUES.has(key) && V1_INERT_VALUES.get(key) === value) continue;
    switch (key) {
      case "do_ocr":
        // The binding's default is to OCR; only the negative needs sending.
        if (value === false) convert.skipOcr = true;
        break;
      case "force_ocr":
        if (value === true) convert.forceFullPageOcr = true;
        break;
      case "ocr_lang":
        if (Array.isArray(value)) convert.ocrLang = value.join(",");
        else if (typeof value === "string" && value) convert.ocrLang = value;
        break;
      case "page_range":
        if (Array.isArray(value) && value.length === 2) {
          const [from, to] = value;
          convert.pages = from === to ? String(from) : `${from}-${to}`;
        }
        break;
      case "image_export_mode":
        if (typeof value === "string") convert.imageMode = value;
        break;
      case "do_code_enrichment":
        if (value === true) convert.doCodeEnrichment = true;
        break;
      case "do_formula_enrichment":
        if (value === true) convert.doFormulaEnrichment = true;
        break;
      case "do_picture_classification":
        if (value === true) convert.doPictureClassification = true;
        break;
      case "abort_on_error":
        // docling-serve's "stop at the first error"; the binding calls it strict.
        if (value === true) convert.strict = true;
        break;
      case "pipeline":
        if (typeof value === "string") convert.pipeline = value;
        break;
      case "include_images":
        // Upstream's nearest question to "give me the pictures", answered by
        // this service's own figure pass rather than by a ConvertOptions field.
        if (value === true) service.figures = "1";
        break;
      default:
        warnings.push({
          option: key,
          detail:
            "no equivalent in this conversion service and was ignored; it reads layout and tables from the file itself",
        });
    }
  }

  return { convert, chunk: {}, service, warnings };
}

/**
 * Whether any conversion option was set — the question that decides whether
 * the warm pipeline may be used, since it ignores them.
 * @param {ParsedOptions} parsed
 * @returns {boolean}
 */
export function hasConvertOptions(parsed) {
  return Object.keys(parsed.convert).length > 0;
}
