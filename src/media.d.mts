/** The extensions docling reads as audio or video. */
export const MEDIA_EXTENSIONS: string[];
export function isMediaFile(filename: string): boolean;
/** The ASR options to add for this file, if any; empty for a document. */
export function asrArgsFor(
  filename: string,
  requested: Record<string, unknown>,
  config?: { defaultModel?: string },
): Record<string, string | number>;
