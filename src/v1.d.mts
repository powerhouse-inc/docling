export type ParsedSource = {
  kind: "file" | "http";
  /** Carries the extension: the format is read from it. */
  filename: string;
  bytes?: Buffer;
  url?: string;
  headers?: Record<string, string>;
};
export function parseSourceRequest(body: Record<string, unknown>): ParsedSource;
export function wantsJson(options: Record<string, unknown> | undefined): boolean;

export type OptionWarning = { option: string; detail: string };

export type Conversion = {
  markdown: string;
  chunks: unknown[];
  format?: string;
  inputName?: string;
  timings?: { convertMs: number; chunkMs: number };
};

export type ConvertDocumentResponse = {
  document: {
    filename: string | null;
    md_content: string;
    json_content: unknown;
    html_content: null;
    text_content: null;
    doctags_content: null;
  };
  status: "success" | "partial_success";
  errors: Array<Record<string, unknown>>;
  processing_time: number;
};

export function toConvertDocumentResponse(
  conversion: Conversion,
  opts: { json: boolean; warnings: OptionWarning[] },
): ConvertDocumentResponse;
