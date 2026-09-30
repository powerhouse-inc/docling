// @ts-check
/**
 * Audio and video, and the options that make docling transcribe them.
 *
 * docling.rs transcribes with Whisper when `asrModel` is set and the ASR
 * models are on disk. Those models are not fetched by default — the fetch
 * passes `--no-asr`, because a service converting invoices has no use for
 * Whisper — so this is opt-in on both sides: the deployment fetches the
 * models and installs ffmpeg, and the request (or the service's default)
 * names a model.
 *
 * The transcription options are only applied to media. A PDF given an
 * `asrModel` would otherwise pay for a decision that cannot apply to it.
 */

/** The extensions docling reads as audio or video. */
export const MEDIA_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
];

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi"]);

/**
 * @param {string} filename
 * @returns {string}
 */
function extensionOf(filename) {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isMediaFile(filename) {
  return MEDIA_EXTENSIONS.includes(extensionOf(filename));
}

/**
 * The ASR options to add for this file, if any.
 *
 * @param {string} filename
 * @param {Record<string, any>} requested the caller's options
 * @param {{ defaultModel?: string }} [config]
 * @returns {Record<string, string | number>}
 */
export function asrArgsFor(filename, requested, config = {}) {
  if (!isMediaFile(filename)) return {};

  /** @type {Record<string, string | number>} */
  const args = {};
  const model = requested.asrModel ?? config.defaultModel;
  if (typeof model === "string" && model) args.asrModel = model;
  if (typeof requested.asrLang === "string" && requested.asrLang) {
    args.asrLang = requested.asrLang;
  }
  // Frame sampling is a video idea; an audio file has no frames to take.
  if (
    VIDEO_EXTENSIONS.has(extensionOf(filename)) &&
    typeof requested.videoFrames === "number"
  ) {
    args.videoFrames = requested.videoFrames;
  }
  return args;
}
