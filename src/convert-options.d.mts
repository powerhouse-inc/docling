/** Options as docling.rs's `ConvertOptions` takes them. */
export type DoclingConvertOptions = Record<string, string | number | boolean>;
/** The chunker's own settings; they never reach ConvertOptions. */
export type DoclingChunkOptions = Record<string, string | number | boolean>;
export type OptionWarning = { option: string; detail: string };

export type ParsedOptions = {
  convert: DoclingConvertOptions;
  chunk: DoclingChunkOptions;
  /** Options with no equivalent here, reported rather than dropped. */
  warnings: OptionWarning[];
};

/** Read `POST /convert`'s query parameters as docling options. */
export function doclingOptionsFromQuery(query: URLSearchParams): ParsedOptions;

/** Translate docling-serve's `options` block onto the binding's names. */
export function doclingOptionsFromV1(
  options: Record<string, unknown> | undefined,
): ParsedOptions;

/**
 * Whether any conversion option was set — the question that decides whether
 * the warm pipeline may be used, since it ignores them.
 */
export function hasConvertOptions(parsed: ParsedOptions): boolean;
