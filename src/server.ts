/**
 * A local document-conversion service over `docling.rs`.
 *
 * The vault talks to this over HTTP (`CONVERT_SERVICE_URL`) through the
 * `subgraphs/convert` proxy. It is deliberately its own process: the binding
 * keeps hundreds of megabytes of ONNX weights resident once it has converted a
 * PDF, and the Switchboard should not carry that.
 *
 * Design points that come from measurement, not taste:
 *
 * - **It starts instantly and loads nothing.** The native binding (~68 MB) is
 *   imported on first use, and the warm `Pipeline` — which holds the ONNX
 *   models — is created only when a PDF or image actually arrives. A fresh
 *   process that has served no documents costs no model memory.
 * - **The warm `Pipeline` serves `pdf` and `image` only.** Its own typings say
 *   so; every declarative format (`md`, `html`, `docx`, `csv`, `epub`, …) goes
 *   through the per-call functions and needs no models at all. That is what
 *   makes "conversion works before the 700 MB is fetched" true rather than
 *   aspirational.
 * - **One instance serialises PDF conversions.** The binding documents that
 *   overlapping calls on one `Pipeline` queue, because the models are mutable
 *   sessions — so batch throughput comes from warm models and extra *processes*,
 *   never from extra concurrent requests.
 * - **It chunks with `chunkFileAsync`, not by re-chunking its own JSON.** Chunking
 *   the document it already converted (`chunkDocumentAsync` on the `to: "json"`
 *   output) measured ~1.6× cheaper, but **disagrees with `chunkFile` on
 *   tables** — on the sample PDF the education table's cells came back
 *   associated differently. Correctness won; re-converting inside the chunker
 *   is cheap because models live for the life of the process (three consecutive
 *   calls: 1630 / 1522 / 1580 ms), not per call.
 * - Model files are ~700 MB and are *not* fetched here at start-up. See
 *   `fetch-models.mjs`, and `/health`, which reports `ready: false` and the
 *   missing list until they exist.
 *
 * Cache hygiene, since "where does the scratch go?" is a fair question:
 *
 * - Per-request scratch (the uploaded bytes, and any qpdf/gs rewrite) lives in
 *   a `mkdtemp` dir removed in a `finally`, so it is gone on the error path
 *   too. Measured after a conversion: zero dirs left behind.
 * - `DOCLING_RS_HOME` is *not* a cache: a conversion writes nothing into it.
 *   The 707 MB there is the models, downloaded once on purpose.
 * - Leftovers therefore only come from a hard kill (`SIGKILL` skips `finally`),
 *   which `sweepStaleTempDirs()` clears at start-up.
 * - **Do not switch on `imageMode: "referenced"`** without cleaning up after
 *   it: that mode writes image files into `artifactsDir`, and nothing here
 *   removes those. `ConvertResult.images` is empty in the current calls, which
 *   is why no artifact cleanup exists.
 * - The one thing that cannot be freed per extraction is the warm pipeline's
 *   ~1.36 GB of loaded models — that warmth is what avoids reloading them per
 *   request. `CONVERT_IDLE_RELEASE_MS` trades it back after a quiet period.
 *
 * Runs on Node and Bun: `node:http` and `node:child_process` are both
 * implemented by Bun, and Node is what Vetra deploys the vault with.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chunk, Pipeline } from "docling.rs";
import { decideRoute, looksGarbled, type OcrCapabilities } from "./routing.mjs";
import { conversionQuality, type ConversionQuality } from "./quality.mjs";
import {
  documentToBlocks,
  insertFigurePlaceholders,
  renderPages,
  runFromItem,
  spliceTables,
  type PageBlocks,
  type Run,
} from "./textlayer.mjs";
import { detectTables, renderTable } from "./tables.mjs";
import {
  altFor,
  applyBudget,
  DEFAULT_MAX_FIGURE_BYTES,
  formulaRegions,
  interiorRows,
  pictureFigures,
  toPixels,
  type Figure,
} from "./figures.mjs";

const PORT = Number(
  process.env.CONVERT_SERVICE_PORT ?? process.env.PORT ?? 5007,
);
const HOST = process.env.CONVERT_SERVICE_HOST ?? "127.0.0.1";

/** `src/server.ts` sits one level below the repository root. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// docling.rs resolves its model home from `DOCLING_RS_HOME` and otherwise falls
// back to the **CWD** — which is wherever the *host* process happened to start,
// so a service autostarted by the vault would look in a different directory from
// the one it was told to. Pin the default to the package root: `<root>/.models`
// is then the same location whether the service is started by hand from the
// repo, from anywhere else, or by the subgraph. An explicit `DOCLING_RS_HOME`
// still wins, which is the knob a real deployment sets (a mounted volume).
process.env.DOCLING_RS_HOME ??= PACKAGE_ROOT;
const MAX_BYTES = Number(process.env.CONVERT_MAX_BYTES ?? 256 * 1024 * 1024);
/**
 * How often to emit a keep-alive byte during a conversion, in ms. 0 disables it.
 *
 * Default 15 s: comfortably inside nginx's 60 s `proxy_read_timeout`, most cloud
 * load balancers' 60 s, and Cloudflare's ~100 s, so the tightest common hop
 * still sees traffic long before it gives up. See `startHeartbeat`.
 */
const HEARTBEAT_MS = Number(process.env.CONVERT_HEARTBEAT_MS ?? 15_000);

/** Prefix for this service's per-request scratch dirs, so it can find its own. */
const TMP_PREFIX = "vault-convert-";

/**
 * How old a scratch dir must be before startup will delete it.
 *
 * Generous on purpose: two services can share one temp dir, and a dir younger
 * than this may belong to a conversion in flight right now.
 */
const STALE_TMP_MS = Number(
  process.env.CONVERT_TMP_STALE_MS ?? 6 * 60 * 60_000,
);

/**
 * Release the warm pipeline after this long with no conversion. `0` = never.
 *
 * Off by default, because warmth is the whole point: the models cost ~1.36 GB
 * resident but a reload per request costs seconds. Turn it on where memory
 * matters more than latency.
 */
const IDLE_RELEASE_MS = Number(process.env.CONVERT_IDLE_RELEASE_MS ?? 0);

/** Format ids that cannot be converted without the downloaded models. */
const MODEL_BACKED_FORMATS = new Set(["pdf", "image", "mets_gbs"]);

// --- binding, resolved on demand -------------------------------------------

/** Import the native binding once, on first use — not at start-up. */
const load = () => import("docling.rs");

let binding: ReturnType<typeof load> | null = null;

function docling(): ReturnType<typeof load> {
  binding ??= load();
  return binding;
}

let warmPipeline: Pipeline | null = null;

/**
 * The warm pipeline, for `pdf` / `image` only.
 *
 * `Pipeline` rejects anything else: it exists to keep the ONNX models loaded
 * across calls, and declarative formats have no models to keep.
 */
function pipelineFor(PipelineClass: typeof Pipeline): Pipeline {
  warmPipeline ??= new PipelineClass();
  return warmPipeline;
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Give the models back after a quiet period — the only "cache" here that can
 * be released, and off unless asked for (see `IDLE_RELEASE_MS`). Dropping the
 * reference is enough: the ONNX sessions belong to the Pipeline and are
 * collected with it.
 */
function scheduleIdleRelease(): void {
  if (IDLE_RELEASE_MS <= 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (warmPipeline !== null) {
      warmPipeline = null;
      console.log(
        `[convert] released the warm pipeline after ${IDLE_RELEASE_MS} ms idle`,
      );
    }
  }, IDLE_RELEASE_MS);
  // A pending release must never keep the process alive.
  idleTimer.unref();
}

/**
 * Delete leftover scratch dirs from a previous run.
 *
 * The per-request dir is removed in a `finally`, so this is only for the cases
 * that skip it: `SIGKILL`, a crash, or the machine going down mid-conversion.
 * Measured after a normal conversion: zero dirs left, which is why this is a
 * safety net rather than routine cleanup.
 *
 * Only entries with this service's prefix, and only ones older than
 * `STALE_TMP_MS`, so a conversion running right now is never deleted.
 */
async function sweepStaleTempDirs(): Promise<number> {
  const root = tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const path = join(root, entry);
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < STALE_TMP_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with another process, or not ours to remove. Not worth failing over.
    }
  }
  return removed;
}

// --- helpers ----------------------------------------------------------------

function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun ? `bun ${bun.version}` : `node ${process.version}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // A heartbeat may already have opened the response to keep a proxy from
  // timing the connection out (see `startHeartbeat`). Once headers are on the
  // wire the status is fixed at 200, so the outcome has to travel in the body:
  // `deferredStatus` carries the code this would have been. Every existing
  // error path funnels through here, so they all keep working unchanged.
  const payload = JSON.stringify(
    res.headersSent && status >= 400 && body && typeof body === "object"
      ? { ...(body as Record<string, unknown>), deferredStatus: status }
      : body,
  );
  if (res.headersSent) {
    res.end(payload);
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Keep a slow conversion's connection from being culled by an idle timeout.
 *
 * A 238-page book takes minutes, and the client allows 30 of them — but nginx's
 * `proxy_read_timeout` defaults to 60 s, most cloud load balancers to 60, and
 * Cloudflare to ~100. Whichever hop is tightest cuts the connection first, and
 * the client sees a network error rather than anything about the document.
 *
 * Proxies reset that timer on **any** byte from upstream, so this writes a
 * single space at intervals. JSON ignores leading whitespace, so a client that
 * calls `response.json()` parses the eventual body unchanged and needs no
 * knowledge of this at all.
 *
 * The cost is honest and worth stating: the first heartbeat commits the status
 * to 200, so an error *after* that point cannot be a 4xx/5xx. `sendJson` puts
 * the real code in `deferredStatus` instead. Errors that arrive before the
 * first interval — the overwhelming majority, since bad input is rejected in
 * milliseconds — are unaffected.
 *
 * Set `CONVERT_HEARTBEAT_MS=0` to switch it off where no proxy sits in front.
 */
function startHeartbeat(res: ServerResponse, intervalMs: number) {
  if (intervalMs <= 0) return { stop: () => {} };

  const timer = setInterval(() => {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "application/json",
        // No content-length: the body is now chunked, since its size is not
        // known until the conversion that is still running finishes.
        "cache-control": "no-store",
      });
    }
    res.write(" ");
  }, intervalMs);
  // Do not hold the process open for a heartbeat.
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

/** Read the raw request body, refusing anything over `MAX_BYTES`. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BYTES) {
        reject(new Error(`body exceeds ${MAX_BYTES} bytes`));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Run a helper binary, resolving to whether it succeeded. */
function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false)); // binary absent
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The rewrites to try, in order, when pdfium refuses a PDF.
 *
 * `qpdf --linearize` first because it is lossless and fast, `gs` second because
 * it rebuilds the page tree wholesale — which is the only thing that helps for
 * some malformations.
 */
const REWRITERS = [
  {
    tool: "qpdf" as const,
    args: (src: string, dst: string) => ["--linearize", src, dst],
  },
  {
    tool: "gs" as const,
    args: (src: string, dst: string) => [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-sDEVICE=pdfwrite",
      `-sOutputFile=${dst}`,
      src,
    ],
  },
];

const isFormatError = (error: unknown): boolean =>
  /FormatError|pdfium/i.test(
    error instanceof Error ? error.message : String(error),
  );

// --- conversion -------------------------------------------------------------

interface Conversion {
  markdown: string;
  chunks: Chunk[];
  format: string;
  inputName: string;
  timings: { convertMs: number; chunkMs: number };
}

/**
 * The OCR path, for a PDF whose text layer exists but lies.
 *
 * **`forceFullPageOcr` only takes effect on the module-level `convertFileAsync`
 * — measured, not assumed.** The warm `Pipeline` class ignores it completely,
 * whether given to its constructor or per-call: on the same 19-page document,
 * `new Pipeline({ forceFullPageOcr: true })` and a plain `Pipeline` both came
 * back 94.0% single-character tokens (unchanged from no OCR at all), while
 * `convertFileAsync(file, { forceFullPageOcr: true })` came back 1.5%. So this
 * path deliberately does NOT use `pipelineFor()` — it costs the warm pipeline's
 * one advantage (model reuse across calls) for the only version that reads.
 *
 * `chunkFileAsync` re-converts the file itself and takes no OCR option, so it
 * would chunk the same glyph soup. The document is converted once with
 * `forceFullPageOcr` to docling JSON and chunked from that — the shortcut the
 * normal path rejects for table fidelity, but against a garbled text layer
 * there is nothing more faithful to compare it to.
 */
async function convertWithOcr(file: string): Promise<Conversion> {
  const library = await docling();

  const convertStart = Date.now();
  const converted = await library.convertFileAsync(file, {
    to: "markdown",
    forceFullPageOcr: true,
  });
  const convertMs = Date.now() - convertStart;

  const chunkStart = Date.now();
  const asJson = await library.convertFileAsync(file, {
    to: "json",
    forceFullPageOcr: true,
  });
  const chunks = await library.chunkDocumentAsync(asJson.content);
  const chunkMs = Date.now() - chunkStart;

  return {
    markdown: converted.content,
    chunks,
    format: converted.format,
    inputName: converted.inputName,
    timings: { convertMs, chunkMs },
  };
}

/**
 * One conversion pass: markdown for the source's own content, plus the chunks
 * the vault turns into sections.
 *
 * Both calls are needed. Chunk text is *not* markdown-quality for tables — a
 * PDF invoice's line items come back as `PART-X, QUANTITY = 480 pcs` triplets —
 * and the binding exposes no json→markdown export to derive one from the other.
 *
 * The chunks deliberately come from `chunkFileAsync`, which converts the file a
 * second time internally even though we already hold a conversion. Chunking our
 * own JSON instead (`chunkDocumentAsync`) is ~1.6× cheaper but loses table
 * fidelity: on the sample PDF the education table's cells came back associated
 * differently, and the two renders were not equal after whitespace
 * normalisation. 0.6 s is a fair price for correct tables.
 */
// --- progress: what the caller can watch while it waits ------------------------

type Phase =
  | "starting"
  | "reading"
  | "structuring"
  | "text-layer"
  | "ocr"
  | "figures"
  | "done"
  | "failed";

/**
 * One entry per in-flight conversion the caller chose to watch (`?job=<id>`).
 * `pagesDone` is measured: the warm pipeline streams markdown as pages finish
 * (24 chunks for a 23-page paper, byte-identical to the buffered result), so
 * a chunk is a page. `structuring` — docling's chunking pass — has no page
 * signal and is shown as a phase, not a bar. Entries linger a minute after
 * completion so a late poll still gets the final state.
 */
interface JobProgress {
  phase: Phase;
  pages: number | null;
  pagesDone: number;
  startedAt: number;
  finishedAt: number | null;
}
const jobs = new Map<string, JobProgress>();
const JOB_TTL_MS = 60_000;

function startJob(id: string | null): JobProgress | null {
  if (!id || !/^[\w-]{1,80}$/.test(id)) return null;
  const job: JobProgress = {
    phase: "starting",
    pages: null,
    pagesDone: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}
function finishJob(
  id: string | null,
  job: JobProgress | null,
  phase: "done" | "failed",
): void {
  if (!id || !job) return;
  job.phase = phase;
  job.finishedAt = Date.now();
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
}

interface ProgressHooks {
  onPhase?: (phase: Phase) => void;
  onPage?: (pagesDone: number) => void;
}

async function convertOnce(
  file: string,
  usePipeline: boolean,
  progress: ProgressHooks = {},
): Promise<Conversion> {
  const library = await docling();
  const { chunkFileAsync, convertFileAsync } = library;
  const warm = usePipeline ? pipelineFor(library.Pipeline) : null;

  progress.onPhase?.("reading");
  const convertStart = Date.now();
  let markdown: string;
  let format: string;
  let inputName: string;
  if (warm) {
    // Streamed, not buffered: identical bytes (measured), and each chunk is a
    // page finishing — the only progress signal the pipeline gives.
    let out = "";
    let pagesDone = 0;
    for await (const chunk of warm.streamFileMarkdown(file)) {
      out += chunk;
      pagesDone += 1;
      progress.onPage?.(pagesDone);
    }
    markdown = out;
    format = extname(file).slice(1).toLowerCase() || "pdf";
    inputName = basename(file);
  } else {
    const converted = await convertFileAsync(file, { to: "markdown" });
    markdown = converted.content;
    format = converted.format;
    inputName = converted.inputName;
  }
  const convertMs = Date.now() - convertStart;

  progress.onPhase?.("structuring");
  const chunkStart = Date.now();
  const chunks = await chunkFileAsync(file);
  const chunkMs = Date.now() - chunkStart;

  return {
    markdown,
    chunks,
    format,
    inputName,
    timings: { convertMs, chunkMs },
  };
}

// --- what this machine can do ------------------------------------------------

/** Run `cmd --version`; true when it exists and exits 0. */
function probeBinary(
  command: string,
  args: string[] = ["--version"],
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

type Capabilities = Omit<OcrCapabilities, "doclingOcr"> & {
  qpdf: boolean;
  gs: boolean;
  /** `sharp` (npm) loads: formula crops need it, together with `gs`. */
  sharp: boolean;
  nice: boolean;
  /** `DOCLING_RS_EP` when a GPU build is in use; the stock binding is CPU-only. */
  executionProvider: string;
};

let probed: Promise<Capabilities> | null = null;

/**
 * Detected once, at first need, and reported through `/health` — the service
 * installs nothing. Tesseract makes a scan fast; without it docling's own OCR
 * is slow but present wherever the models are; without either a scan is
 * `unreadable`, and the response says which tool would change that.
 */
function capabilities(): Promise<Capabilities> {
  probed ??= (async () => {
    const [tesseract, ocrmypdf, qpdf, gs, nice, sharp] = await Promise.all([
      probeBinary("tesseract"),
      probeBinary("ocrmypdf"),
      probeBinary("qpdf"),
      probeBinary("gs"),
      process.platform === "win32"
        ? Promise.resolve(false)
        : probeBinary("nice"),
      import("sharp").then(
        () => true,
        () => false,
      ),
    ]);
    return {
      tesseract,
      ocrmypdf,
      qpdf,
      gs,
      sharp,
      nice,
      executionProvider: process.env.DOCLING_RS_EP ?? "cpu",
    };
  })();
  return probed;
}

/** OCR runs in parallel across this many pages; bounded so it never takes the whole box. */
const OCR_JOBS = Math.max(
  1,
  Math.min(cpus().length, Number(process.env.CONVERT_OCR_JOBS ?? 8)),
);
/** Above this estimated cost, OCR is offered rather than run — the user decides. */
const AUTO_OCR_BUDGET_SECONDS = Number(
  process.env.CONVERT_AUTO_OCR_SECONDS ?? 60,
);
const OCR_LANG = process.env.CONVERT_OCR_LANG ?? "eng";

/**
 * One heavy conversion at a time. The warm pipeline already serialises its own
 * calls, but the OCR paths do not share it — two overlapping requests would run
 * two OCR passes at once, which on a 16-core laptop read as "the machine hung".
 * A second caller gets an immediate 503 naming what is running, not a queue.
 */
let busy: { filename: string; since: number } | null = null;

/** Run a helper with lower scheduling priority when `nice` exists, capturing stderr for the error path. */
function runNiced(
  command: string,
  args: string[],
  canNice: boolean,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = canNice
      ? spawn("nice", ["-n", "10", command, ...args], {
          stdio: ["ignore", "ignore", "pipe"],
        })
      : spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (error) => resolve({ ok: false, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });
}

// --- the text layer, read by pdf.js -------------------------------------------

/**
 * pdf.js reads fonts pdfium cannot: measured on a report re-exported with
 * Type 3 fonts under custom encodings, pdfium returned 96 % single-character
 * tokens and pdf.js 1.2 %, in 0.4 s for 19 pages. Pure npm, so this rung exists
 * on every machine the service runs on. It yields text, not layout.
 */
async function extractTextWithPdfjs(bytes: Uint8Array): Promise<{
  text: string;
  markdown: string;
  pages: number;
  headings: number;
  blocks: PageBlocks[];
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const pages: Run[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const runs: Run[] = [];
    for (const item of content.items)
      if ("str" in item) runs.push(runFromItem(item));
    pages.push(runs);
  }
  const count = doc.numPages;
  await task.destroy();
  // `text` is the flat layer (garble check, coverage); `markdown` has the
  // headings and paragraphs the geometry gives away — see textlayer.mjs.
  // Blocks first, then the tables that cover some of them: a table's cells
  // arrive as ordinary blocks, so the grid has to take their place or every
  // number is written twice (see tables.mjs).
  const blocks = documentToBlocks(pages).pages.map((page, index) => ({
    ...page,
    blocks: spliceTables(
      page.blocks,
      detectTables(pages[index]).map((table) => ({
        ...table,
        markdown: renderTable(table.grid),
      })),
    ),
  }));
  const markdown = renderPages(blocks);
  const flat = pages
    .map((runs) =>
      runs
        .map((r) => r.str + (r.eol ? "\n" : " "))
        .join("")
        .trim(),
    )
    .join("\n\n");
  return {
    text: flat,
    markdown,
    pages: count,
    headings: (markdown.match(/^#{1,2} /gm) ?? []).length,
    // The same blocks, so a figure can be placed among them when this rung's
    // markdown is the one that ships.
    blocks,
  };
}

/**
 * OCR'd text comes back with doubled spaces between words ("Total  stablecoin
 * supply"); collapse them in prose only — table rows, indented and fenced code
 * keep theirs.
 */
function tidyOcrSpacing(markdown: string): string {
  let inCode = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) inCode = !inCode;
      if (inCode || line.startsWith("|") || line.startsWith("    "))
        return line;
      return line.replace(/(\S) {2,}(?=\S)/g, "$1 ");
    })
    .join("\n");
}

/** A conversion built from plain text: the text is the markdown, chunked by docling. */
async function conversionFromText(
  text: string,
  dir: string,
  inputName: string,
): Promise<Conversion> {
  const library = await docling();
  const path = join(dir, "text-layer.md");
  await writeFile(path, text);
  const chunkStart = Date.now();
  const chunks = await library.chunkFileAsync(path);
  return {
    markdown: text,
    chunks,
    format: "pdf",
    inputName,
    timings: { convertMs: 0, chunkMs: Date.now() - chunkStart },
  };
}

/**
 * Tesseract, through ocrmypdf: writes a PDF with a real text layer, which
 * docling then reads with its normal pass — headings, tables and the section
 * rule keep working, which the pdf.js rung cannot offer. `--skip-text` OCRs
 * only pages without text; `--force-ocr` replaces a text layer that lies.
 */
async function ocrWithTesseract(
  file: string,
  dir: string,
  mode: "skip-text" | "force-ocr",
  canNice: boolean,
): Promise<{ path: string } | { error: string }> {
  const out = join(dir, "tesseract.pdf");
  const args = [
    `--${mode}`,
    "--jobs",
    String(OCR_JOBS),
    "--output-type",
    "pdf",
    "-l",
    OCR_LANG,
    file,
    out,
  ];
  const { ok, stderr } = await runNiced("ocrmypdf", args, canNice);
  return ok
    ? { path: out }
    : {
        error:
          stderr.trim().split("\n").slice(-3).join(" ") || "ocrmypdf failed",
      };
}

/** Above this many base64 bytes of figures per file, formulas are dropped first, then pictures. */
const MAX_FIGURE_BYTES = Number(
  process.env.CONVERT_FIGURES_MAX_BYTES ?? DEFAULT_MAX_FIGURE_BYTES,
);
/**
 * Resolution of the page renders figures are cut from, per kind.
 *
 * A picture is page-sized, so the PDF's own 72 dpi already gives a sharp crop
 * (the Sky report's charts come out ~1300 px wide). A display formula is one
 * line tall: at 72 dpi it is ~240×34 px and its superscripts are mush, which
 * defeats the point — the crop exists to be read, by a person or a vision
 * model. Rendering costs roughly the square of the resolution (measured on
 * the 19-page Sky report: 6.7 s at 72 dpi, 24.7 s at 200), so each page is
 * rendered at what the figures on it need, and no page twice at one setting.
 */
const FIGURE_TARGET_PX = Math.max(
  200,
  Number(process.env.CONVERT_FIGURE_TARGET_PX ?? 900),
);
/** An embed at least this wide is accepted as is — rendering its page buys little. */
/**
 * How figure PNGs are written. Charts, diagrams and formula crops are flat
 * colour on white, so a 256-colour palette is visually identical and a
 * fraction of the bytes — these live in the attachment store and travel to
 * every reader, human or model.
 */
const FIGURE_PNG = {
  compressionLevel: 9,
  palette: true,
  colours: Math.max(2, Number(process.env.CONVERT_FIGURE_COLOURS ?? 128)),
  quality: Math.max(10, Number(process.env.CONVERT_FIGURE_PNG_QUALITY ?? 80)),
  effort: 8,
} as const;

/** Pictures never need the high end: they are read whole, not glyph by glyph. */
const FIGURE_MAX_PICTURE_DPI = Math.max(
  36,
  Number(process.env.CONVERT_FIGURE_MAX_PICTURE_DPI ?? 150),
);
const FIGURE_EMBED_FLOOR_PX = Math.max(
  200,
  Number(process.env.CONVERT_FIGURE_EMBED_FLOOR_PX ?? 600),
);
const FIGURE_MIN_DPI = Math.max(
  36,
  Number(process.env.CONVERT_FIGURE_MIN_DPI ?? 72),
);
const FIGURE_MAX_DPI = Math.max(
  FIGURE_MIN_DPI,
  Number(process.env.CONVERT_FIGURE_MAX_DPI ?? 200),
);

/**
 * The resolution a figure is rendered at, from its width on the page.
 *
 * Kind is the wrong dial: the Sky report's charts are page-wide and sharp at
 * the PDF's own 72 dpi (~1300 px), while the paper's inline diagrams come out
 * 180 px and its display formulas ~240x34 — mush, which defeats a crop whose
 * purpose is to be read, by a person or a vision model. So each figure asks
 * for about `FIGURE_TARGET_PX` of width, bounded, rounded to a step so
 * near-identical widths share one page render. Rendering costs roughly the
 * square of the resolution (19-page Sky report: 6.7 s at 72 dpi, 24.7 s at 200).
 */
/**
 * Whether docling's own PNG is at least as good as rendering the page would
 * be. It usually is for a designed report (the Sky charts embed at 2655 px)
 * and usually is not for a paper's inline diagrams (683 px for a figure a
 * render gives at 951). Using it skips the page render entirely.
 */
function embedIsEnough(picture: {
  width: number;
  png: string;
  box: { l: number; r: number } | null;
}): boolean {
  if (!picture.png || picture.width <= 0) return false;
  // Readable on its own terms: no page render just to gain pixels nobody reads.
  if (picture.width >= FIGURE_EMBED_FLOOR_PX) return true;
  const widthPt = picture.box ? Math.max(1, picture.box.r - picture.box.l) : 0;
  if (widthPt <= 0) return true; // no box to render from: the embed is all there is
  const renderedWidth = (dpiFor(picture.box, "picture") / 72) * widthPt;
  return picture.width >= renderedWidth * 0.9;
}

function dpiFor(
  box: { l: number; r: number } | null,
  kind: "picture" | "formula" = "formula",
): number {
  const widthPt = box ? Math.max(1, box.r - box.l) : 0;
  const wanted =
    widthPt > 0 ? (FIGURE_TARGET_PX / widthPt) * 72 : FIGURE_MIN_DPI;
  // A formula is read glyph by glyph, so it earns the high end; a picture that
  // is small on the page is a logo or an inline mark, and rendering its whole
  // page at 200 dpi (measured: 16 s across the Sky report) buys nothing.
  const max = kind === "formula" ? FIGURE_MAX_DPI : FIGURE_MAX_PICTURE_DPI;
  const clamped = Math.min(max, Math.max(FIGURE_MIN_DPI, wanted));
  return Math.ceil(clamped / 25) * 25;
}

interface FigureStats {
  pictures: number;
  formulas: number;
  located: number;
  skipped: number;
  droppedForBudget: number;
  /** Figures the text-layer rung could not position among the blocks (no box). */
  unplaced?: number;
  jsonMs: number;
  renderMs: number;
}

/**
 * The pictures and display formulas of a PDF, as PNGs (see figures.mjs).
 * Pictures come embedded in docling's JSON; formulas are located by the gap
 * between their neighbours and cut from a Ghostscript render of the page at
 * a resolution chosen from its size (dpiFor). Degrades: no `gs`/`sharp` → pictures only.
 */
async function collectFigures(
  file: string,
  dir: string,
  usePipeline: boolean,
  hooks: ProgressHooks,
): Promise<{ figures: Figure[]; stats: FigureStats }> {
  const library = await docling();
  const warm = usePipeline ? pipelineFor(library.Pipeline) : null;
  const jsonStart = Date.now();
  const json = warm
    ? await warm.convertFileAsync(file, { to: "json" })
    : await library.convertFileAsync(file, { to: "json" });
  const jsonMs = Date.now() - jsonStart;
  const doc = JSON.parse(json.content) as {
    pages?: Record<string, { size: { width: number; height: number } }>;
  };
  const pageSize = (page: number) => doc.pages?.[String(page)]?.size;

  const pictures = pictureFigures(doc);
  const { regions, total } = formulaRegions(doc);
  const caps = await capabilities();
  const canRender = caps.gs && caps.sharp;

  const figures: Figure[] = [];
  /**
   * Down to `FIGURE_TARGET_PX` wide, when it is wider and sharp is here: a
   * 2655 px chart is 2 MB on the wire and in the attachment store for no gain
   * over ~1000 px, which is what a reader or a vision model uses.
   */
  async function fit(
    base64: string,
    width: number,
    height: number,
  ): Promise<{ base64: string; width: number; height: number }> {
    if (width <= FIGURE_TARGET_PX || !canRender)
      return { base64, width, height };
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(Buffer.from(base64, "base64"))
        .resize({ width: FIGURE_TARGET_PX, withoutEnlargement: true })
        .png(FIGURE_PNG)
        .toBuffer({ resolveWithObject: true });
      return {
        base64: out.data.toString("base64"),
        width: out.info.width,
        height: out.info.height,
      };
    } catch {
      return { base64, width, height };
    }
  }

  const embedded = (p: (typeof pictures)[number]): Figure => ({
    id: `picture-${p.placeholderIndex + 1}`,
    kind: "picture",
    page: p.page,
    box: p.box,
    placeholderIndex: p.placeholderIndex,
    alt: altFor({
      kind: "picture",
      page: p.page,
      placeholderIndex: p.placeholderIndex,
      caption: p.caption,
    }),
    mimeType: "image/png",
    width: p.width,
    height: p.height,
    bytesBase64: p.png,
  });

  let renderMs = 0;
  let located = 0;
  if (!canRender) {
    // No Ghostscript or no sharp: docling's own PNGs, formulas stay placeholders.
    for (const p of pictures) figures.push(embedded(p));
  } else {
    const sharp = (await import("sharp")).default;
    const renderStart = Date.now();
    // One render per page that holds a picture with a box or a located formula.
    // (page, dpi) pairs: a page is rendered once per resolution its own
    // figures ask for — small diagrams and formulas pull it up, page-wide
    // charts leave it at the PDF's own 72 dpi.
    const wanted = new Map<string, { page: number; dpi: number }>();
    for (const p of pictures) {
      // docling embeds every picture; render one only when its embed is
      // smaller than we want to read. On a report of page-wide charts that
      // skips the page renders entirely (measured: 19.7 s → 6.8 s).
      if (!p.box || !p.page || embedIsEnough(p)) continue;
      const dpi = dpiFor(p.box, "picture");
      wanted.set(`${p.page}@${dpi}`, { page: p.page, dpi });
    }
    for (const r of regions) {
      const dpi = dpiFor(r.box);
      wanted.set(`${r.page}@${dpi}`, { page: r.page, dpi });
    }
    const rendered = new Map<string, string>();
    for (const { page, dpi } of wanted.values()) {
      const out = join(dir, `page-${page}-${dpi}.png`);
      const ok = await run("gs", [
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=png16m",
        `-r${dpi}`,
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-sOutputFile=${out}`,
        file,
      ]);
      if (ok) rendered.set(`${page}@${dpi}`, out);
    }

    // Pictures: docling embeds them at 72 dpi; the page render is 2.8× sharper.
    for (const p of pictures) {
      if (embedIsEnough(p)) {
        const shrunk = await fit(p.png, p.width, p.height);
        figures.push({
          ...embedded(p),
          width: shrunk.width,
          height: shrunk.height,
          bytesBase64: shrunk.base64,
        });
        continue;
      }
      const dpi = dpiFor(p.box);
      const png =
        p.box && p.page ? rendered.get(`${p.page}@${dpi}`) : undefined;
      const size = pageSize(p.page);
      if (!png || !size || !p.box) {
        figures.push(embedded(p));
        continue;
      }
      const rect = toPixels(p.box, size, dpi);
      try {
        const buffer = await sharp(png)
          .extract(rect)
          .png(FIGURE_PNG)
          .toBuffer();
        figures.push({
          ...embedded(p),
          width: rect.width,
          height: rect.height,
          bytesBase64: buffer.toString("base64"),
        });
      } catch {
        figures.push(embedded(p));
      }
    }

    // Formulas: the gap includes the neighbours' line spacing, so the raw crop
    // starts with the bottom of one line and ends with the top of the next.
    // Keep the interior ink band (figures.mjs interiorRows).
    for (const region of regions) {
      const dpi = dpiFor(region.box);
      const png = rendered.get(`${region.page}@${dpi}`);
      const size = pageSize(region.page);
      if (!png || !size) continue;
      const rect = toPixels(region.box, size, dpi);
      try {
        const raw = await sharp(png)
          .extract(rect)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const { width, height } = raw.info;
        const rowInk: number[] = [];
        for (let y = 0; y < height; y++) {
          let ink = 0;
          for (let x = 0; x < width; x++)
            if (raw.data[y * width + x] < 160) ink += 1;
          rowInk.push(ink);
        }
        const band = interiorRows(rowInk, { minGap: 4 });
        const tight = {
          left: rect.left,
          top: rect.top + band.top,
          width: rect.width,
          height: band.height,
        };
        const buffer = await sharp(png)
          .extract(tight)
          .png(FIGURE_PNG)
          .toBuffer();
        figures.push({
          id: `formula-${region.placeholderIndex + 1}`,
          kind: "formula",
          page: region.page,
          box: region.box,
          placeholderIndex: region.placeholderIndex,
          alt: altFor({
            kind: "formula",
            page: region.page,
            placeholderIndex: region.placeholderIndex,
          }),
          mimeType: "image/png",
          width: tight.width,
          height: tight.height,
          bytesBase64: buffer.toString("base64"),
        });
        located += 1;
        hooks.onPage?.(located); // the client shows "figure N" while this runs
      } catch {
        // a crop outside the render: the placeholder stays
      }
    }
    renderMs = Date.now() - renderStart;
  }

  const { kept, dropped } = applyBudget(figures, MAX_FIGURE_BYTES);
  return {
    figures: kept,
    stats: {
      pictures: pictures.length,
      formulas: total,
      located,
      skipped: total - located,
      droppedForBudget: dropped,
      jsonMs,
      renderMs,
    },
  };
}

async function handleConvert(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const filename = basename(url.searchParams.get("filename") ?? "");
  if (!filename) {
    sendJson(res, 400, { error: "filename query parameter is required" });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readBody(req);
  } catch (error) {
    sendJson(res, 413, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (bytes.length === 0) {
    sendJson(res, 400, { error: "empty body" });
    return;
  }

  if (busy) {
    sendJson(res, 503, {
      error: `a conversion is already running (${busy.filename}, ${Math.round((Date.now() - busy.since) / 1000)} s ago); try again when it finishes`,
      code: "CONVERSION_BUSY",
      busyWith: busy.filename,
      sinceMs: Date.now() - busy.since,
    });
    return;
  }
  busy = { filename, since: Date.now() };
  const jobId = url.searchParams.get("job");
  const job = startJob(jobId);
  const hooks: ProgressHooks = {
    onPhase: (phase) => {
      if (job) job.phase = phase;
    },
    onPage: (n) => {
      if (job) job.pagesDone = job.pages === null ? n : Math.min(n, job.pages);
    },
  };

  let library: Awaited<ReturnType<typeof docling>>;
  try {
    library = await docling();
  } catch (error) {
    busy = null;
    finishJob(jobId, job, "failed");
    sendJson(res, 503, {
      error: "the docling.rs binding is not installed",
      detail: error instanceof Error ? error.message : String(error),
      hintForOperators: "run `bun install` in the vault package",
    });
    return;
  }

  const format = library.formatFromName(filename);
  const usePipeline = format !== null && MODEL_BACKED_FORMATS.has(format);
  const dependencies = library.checkDependencies();

  // Models are only needed for the model-backed formats. Everything else works
  // on a fresh install, which is what lets the UI offer the 700 MB download
  // instead of failing.
  if (usePipeline && !dependencies.ready) {
    busy = null;
    finishJob(jobId, job, "failed");
    sendJson(res, 415, {
      error: `cannot convert ${format} without the docling models`,
      missing: dependencies.missing,
      modelsDir: dependencies.home,
      hintForOperators:
        "npm run fetch-models — downloads ~700 MB, once",
    });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "vault-convert-"));
  const started = Date.now();
  try {
    const file = join(dir, filename);
    await writeFile(file, bytes);

    // The text layer, read once up front by pdf.js (0.4 s for 19 pages): the
    // page count feeds the progress bar, the text feeds the quality score, and
    // both feed the routing decision if pdfium's result turns out garbled.
    const isPdf = filename.toLowerCase().endsWith(".pdf");
    let layer: {
      garbled: boolean;
      chars: number;
      text: string;
      markdown: string;
      pages: number;
      blocks: PageBlocks[];
    } | null = null;
    if (isPdf) {
      try {
        const extracted = await extractTextWithPdfjs(new Uint8Array(bytes));
        layer = {
          garbled: looksGarbled(extracted.text),
          chars: extracted.text.trim().length,
          text: extracted.text,
          markdown: extracted.markdown,
          pages: extracted.pages,
          blocks: extracted.blocks,
        };
        if (job) job.pages = extracted.pages;
      } catch {
        layer = null; // pdf.js could not open it; the OCR rungs decide later
      }
    }

    let result: Conversion | null = null;
    let normalised: "qpdf" | "gs" | null = null;
    let refusal: unknown = null;

    try {
      result = await convertOnce(file, usePipeline, hooks);
    } catch (error) {
      // Rewrite only when pdfium actually refused the file, and only for PDFs.
      if (!isPdf || !isFormatError(error)) throw error;
      refusal = error;

      // "The tool exited 0" is NOT the test — "the rewritten file converts" is.
      // Measured: on a PDF whose page tree declares more pages than it has,
      // `qpdf --linearize` exits 0 and leaves the file just as refused (it
      // preserves the bad /Count), while `gs` rebuilds the tree and cures it.
      // So each rewrite is tried and then converted; the first that works wins.
      for (const rewriter of REWRITERS) {
        const target = join(dir, `normalised-${rewriter.tool}.pdf`);
        if (!(await run(rewriter.tool, rewriter.args(file, target)))) continue;
        try {
          result = await convertOnce(target, usePipeline, hooks);
          normalised = rewriter.tool;
          break;
        } catch {
          // This rewrite did not help; try the next one.
        }
      }
    }

    // pdfium refused it and no rewrite produced something it accepts.
    if (result === null) {
      finishJob(jobId, job, "failed");
      sendJson(res, 415, {
        error: "the document could not be read, even after rewriting it",
        detail: refusal instanceof Error ? refusal.message : String(refusal),
        attempted: REWRITERS.map((rewriter) => rewriter.tool),
        hintForOperators:
          "pdfium refused this PDF and neither qpdf nor ghostscript produced a file it accepts",
      });
      return;
    }

    // pdfium read the file, but did it read words? If not — or if the caller
    // asked for OCR outright with `?ocr=1` — decide how to read it from what the
    // file is and what this machine has (see routing.mjs). Cheapest rung first;
    // nothing is installed; the response says which rung produced the text.
    let ocr: "tesseract" | "docling" | null = null;
    let textSource: "docling" | "pdfjs" | "tesseract" | "docling-ocr" =
      "docling";
    let needsOcr: {
      via: "tesseract" | "docling-ocr";
      estimateSeconds: number;
    } | null = null;
    let pages: number | null = null;
    let ocrMs = 0;
    const ocrRequested = url.searchParams.get("ocr") === "1";
    const wantFigures = url.searchParams.get("figures") === "1";
    const doclingGarbled = looksGarbled(result.markdown);
    if (usePipeline && (ocrRequested || doclingGarbled)) {
      const source = normalised
        ? join(dir, `normalised-${normalised}.pdf`)
        : file;
      pages = layer?.pages ?? null;
      const caps = await capabilities();
      const route = decideRoute({
        doclingGarbled,
        pdfjs: layer ? { garbled: layer.garbled, chars: layer.chars } : null,
        pages: pages ?? 1,
        capabilities: {
          tesseract: caps.tesseract,
          ocrmypdf: caps.ocrmypdf,
          doclingOcr: dependencies.ocr,
        },
        forceOcr: ocrRequested,
        autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
        jobs: OCR_JOBS,
      });

      const ocrStart = Date.now();
      switch (route.kind) {
        case "docling":
          break;
        case "pdfjs":
          if (layer) {
            hooks.onPhase?.("text-layer");
            result = await conversionFromText(layer.markdown, dir, filename);
            textSource = "pdfjs";
          }
          break;
        case "tesseract": {
          hooks.onPhase?.("ocr");
          const out = await ocrWithTesseract(
            source,
            dir,
            route.mode,
            caps.nice,
          );
          if ("path" in out) {
            result = await convertOnce(out.path, true, hooks);
            ocr = "tesseract";
            textSource = "tesseract";
          } else if (dependencies.ocr) {
            // Tesseract is installed but failed on this file: docling's own OCR is the last rung.
            result = await convertWithOcr(source);
            ocr = "docling";
            textSource = "docling-ocr";
          } else {
            finishJob(jobId, job, "failed");
            sendJson(res, 415, {
              error:
                "the document could not be read: its text is unusable and OCR failed",
              detail: out.error,
              capabilities: caps,
            });
            return;
          }
          break;
        }
        case "docling-ocr":
          hooks.onPhase?.("ocr");
          result = await convertWithOcr(source);
          ocr = "docling";
          textSource = "docling-ocr";
          break;
        case "needs-ocr":
          // Over the budget: say what it would cost and let the caller decide
          // (`?ocr=1`). No text is returned — glyph soup is not a source.
          needsOcr = { via: route.via, estimateSeconds: route.estimateSeconds };
          result = { ...result, markdown: "", chunks: [] };
          break;
        case "unreadable":
          finishJob(jobId, job, "failed");
          sendJson(res, 415, {
            error:
              "the document's text is unusable and nothing here can OCR it",
            capabilities: caps,
            hintForOperators:
              "install tesseract + ocrmypdf on the machine running the conversion service, or fetch the docling models (npm run fetch-models)",
          });
          return;
      }
      // OCR that still reads as soup is worse than the text layer already in
      // hand: fall back to it rather than hand the user unreadable parts.
      if (result && ocr !== null) {
        if (looksGarbled(result.markdown) && layer && !layer.garbled) {
          result = await conversionFromText(layer.markdown, dir, filename);
          ocr = null;
          textSource = "pdfjs";
        } else {
          result = { ...result, markdown: tidyOcrSpacing(result.markdown) };
        }
      }
      ocrMs = Date.now() - ocrStart;
    }

    // The text layer read, but flat: tables and bullets are gone. Say what OCR
    // would cost to get them back, so the UI can offer it instead of guessing.
    let ocrOffer: {
      via: "tesseract" | "docling-ocr";
      estimateSeconds: number;
    } | null = null;
    if (textSource === "pdfjs") {
      const caps = await capabilities();
      const offer = decideRoute({
        doclingGarbled: true,
        pdfjs: layer ? { garbled: layer.garbled, chars: layer.chars } : null,
        pages: pages ?? layer?.pages ?? 1,
        capabilities: {
          tesseract: caps.tesseract,
          ocrmypdf: caps.ocrmypdf,
          doclingOcr: dependencies.ocr,
        },
        forceOcr: true,
        autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
        jobs: OCR_JOBS,
      });
      if (offer.kind === "tesseract" || offer.kind === "docling-ocr") {
        ocrOffer = { via: offer.kind, estimateSeconds: offer.estimateSeconds };
      }
    }

    // The document's pictures and display formulas as images, on request. Only
    // when docling wrote the markdown: the text-layer rung has no placeholders
    // to put them in.
    let figures: Figure[] = [];
    let figureStats: FigureStats | null = null;
    if (wantFigures && isPdf) {
      hooks.onPhase?.("figures");
      if (job) {
        job.pagesDone = 0;
        job.pages = null;
      }
      const figureSource = normalised
        ? join(dir, `normalised-${normalised}.pdf`)
        : file;
      try {
        const collected = await collectFigures(
          figureSource,
          dir,
          usePipeline,
          hooks,
        );
        figures = collected.figures;
        figureStats = collected.stats;

        // The text-layer rung wrote this markdown from pdf.js runs, so it has
        // no `<!-- image -->` / `<!-- formula-not-decoded -->` placeholders for
        // the figures to land in — docling's layout model still found them
        // (it reads pixels, not fonts), and both sides use the same page
        // coordinates. Place each figure among the text blocks, renumber the
        // placeholders in the order they now appear, and re-chunk, because the
        // sections are cut from the markdown.
        if (textSource === "pdfjs" && layer && figures.length > 0 && result) {
          const placed = insertFigurePlaceholders(layer.blocks, figures, {
            picture: "<!-- image -->",
            formula: "<!-- formula-not-decoded -->",
          });
          const counters = { picture: 0, formula: 0 };
          figures = placed.placed.map((figure) => {
            // The caption may have just arrived from the chart's own title,
            // absorbed out of the text layer, so the alt text — the first
            // thing a model reads about a figure — is rebuilt from it.
            const renumbered = {
              ...figure,
              placeholderIndex: counters[figure.kind]++,
            };
            return { ...renumbered, alt: altFor(renumbered) };
          });
          result = await conversionFromText(placed.markdown, dir, filename);
          // `unplaced` is its own count: a figure with no box could not be
          // positioned among the text — not the same as one left out for size.
          figureStats = {
            ...collected.stats,
            unplaced: placed.unplaced.length,
          };
        }
      } catch (error) {
        console.warn(
          `[convert] figures failed for ${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // How much of the file's own text made it through — measured against the
    // text layer pdf.js read, so it is a floor on completeness, never a proof.
    const quality: ConversionQuality | null =
      layer && !needsOcr
        ? conversionQuality(layer.text, result.markdown)
        : null;

    // A conversion just happened: re-arm the idle release if it is enabled.
    scheduleIdleRelease();
    finishJob(jobId, job, "done");

    sendJson(res, 200, {
      markdown: result.markdown,
      chunks: result.chunks,
      format: result.format,
      inputName: result.inputName,
      timings: { ...result.timings, ocrMs, totalMs: Date.now() - started },
      backend: "docling.rs",
      normalised,
      ocr,
      textSource,
      needsOcr,
      ocrOffer,
      pages: pages ?? layer?.pages ?? null,
      quality,
      figures,
      figureStats,
    });
  } finally {
    busy = null;
    await rm(dir, { recursive: true, force: true });
  }
}

/** `/health`: the two independent states — binding present, models present. */
async function handleHealth(res: ServerResponse): Promise<void> {
  try {
    const library = await docling();
    const dependencies = library.checkDependencies();
    sendJson(res, 200, {
      ok: true,
      backend: "docling.rs",
      runtime: runtimeName(),
      ready: dependencies.ready,
      missing: dependencies.missing,
      modelsDir: dependencies.home,
      modelsLoaded: warmPipeline !== null,
      formats: library.supportedFormats(),
      // What this machine can do about a scan, so a UI can say "fast", "slow" or
      // "install …" before anyone drops a file.
      capabilities: { ...(await capabilities()), doclingOcr: dependencies.ocr },
      ocrEngine:
        (await capabilities()).tesseract && (await capabilities()).ocrmypdf
          ? "tesseract"
          : dependencies.ocr
            ? "docling"
            : null,
      autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
    });
  } catch (error) {
    sendJson(res, 503, {
      ok: false,
      backend: "docling.rs",
      runtime: runtimeName(),
      error: "the docling.rs binding is not installed",
      detail: error instanceof Error ? error.message : String(error),
      hintForOperators: "run `bun install` in the vault package",
    });
  }
}

// --- server -----------------------------------------------------------------

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        await handleHealth(res);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/progress/")) {
        const job = jobs.get(
          decodeURIComponent(url.pathname.slice("/progress/".length)),
        );
        if (!job) {
          sendJson(res, 404, {
            error: "no such job (finished jobs are kept for a minute)",
            code: "JOB_NOT_FOUND",
          });
          return;
        }
        sendJson(res, 200, {
          phase: job.phase,
          pages: job.pages,
          pagesDone: job.pagesDone,
          elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/convert") {
        // The heartbeat starts before the work, not after the body is read: a
        // large upload over a slow link is itself long enough to trip an idle
        // timeout, and nothing has been written yet at that point.
        const heartbeat = startHeartbeat(res, HEARTBEAT_MS);
        try {
          await handleConvert(req, res, url);
        } finally {
          heartbeat.stop();
        }
        return;
      }
      if (url.pathname === "/") {
        sendJson(res, 200, {
          service: "vault-convert",
          endpoints: ["GET /health", "POST /convert?filename=<name>"],
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|command not found/i.test(message)) {
        sendJson(res, 415, { error: message });
        return;
      }
      sendJson(res, 500, { error: message });
    }
  })();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  // One line, so `docker logs` / journald show something useful at start-up.
  console.log(
    `vault-convert listening on http://${HOST}:${PORT} (${runtimeName()})`,
  );
  if (IDLE_RELEASE_MS > 0) {
    console.log(`[convert] idle release: ${IDLE_RELEASE_MS} ms`);
    scheduleIdleRelease();
  }
  // After listening, so a slow sweep never delays readiness.
  void sweepStaleTempDirs().then((removed) => {
    if (removed > 0) {
      console.log(
        `[convert] swept ${removed} stale scratch dir(s) from a previous run`,
      );
    }
  });
});
