#!/usr/bin/env node
/**
 * Fetch the docling.rs PDF/image models — ~700 MB, once, deliberately.
 *
 * Why this is a command you run rather than something automatic:
 *
 * - **Not at install.** The package ships `dist/` plus this service; 700 MB of
 *   ONNX weights in the tarball would grow the registry, every `bun install`,
 *   and would freeze a snapshot of third-party model files that docling.rs
 *   already publishes itself.
 * - **Not at start-up.** Two costs would land on the vault's boot: the download
 *   itself (boot becomes network-bound, and a failure leaves a half-working
 *   deployment) and the resident memory once models load (~1.36 GB under Node,
 *   ~2.78 GB under Bun, measured) competing with the Switchboard's own start-up.
 *
 * So: fetch once, into a directory of your choosing, before you need PDFs. The
 * service starts instantly with no models and reports `ready: false` from
 * `/health` until this has run; every declarative format (`md`, `html`, `docx`,
 * `csv`, `epub`, …) already works without it.
 *
 *   npm run fetch-models
 *   DOCLING_RS_HOME=/var/lib/vault-models npm run fetch-models
 *
 * Safe to re-run: the upstream script skips files that are already present.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_URL =
  "https://raw.githubusercontent.com/docling-project/docling.rs/master/scripts/install/download_dependencies.sh";

// ASR is Whisper-tiny and is for audio/video only; the vault converts documents.
const SCRIPT_ARGS = ["--no-asr"];

// Same default as `server.ts`: the package root, not the CWD, so the fetch and
// the service agree no matter where either is started from.
const home = resolve(
  process.env.DOCLING_RS_HOME ??
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

/**
 * The download script is fetched fresh each run and shown before it executes —
 * byte size and sha256 — so the operator can see what is about to run. Pin it
 * with `DOCLING_DOWNLOAD_SCRIPT_SHA256` to fail closed on a changed upstream.
 */
async function fetchScript() {
  const dir = await mkdtemp(join(tmpdir(), "docling-fetch-"));
  const path = join(dir, "download_dependencies.sh");

  const response = await fetch(SCRIPT_URL);
  if (!response.ok) {
    throw new Error(`could not fetch ${SCRIPT_URL} — HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes, { mode: 0o644 });

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`download script : ${SCRIPT_URL}`);
  console.log(`                  ${bytes.length} bytes  sha256 ${sha256}`);

  const expected = process.env.DOCLING_DOWNLOAD_SCRIPT_SHA256;
  if (expected && expected !== sha256) {
    throw new Error(`download script sha256 mismatch\n  expected ${expected}\n  actual   ${sha256}`);
  }
  if (!expected) {
    console.log("                  (set DOCLING_DOWNLOAD_SCRIPT_SHA256 to pin this)");
  }

  return { dir, path };
}

async function main() {
  console.log(`models directory: ${home}   (DOCLING_RS_HOME)\n`);

  const script = await fetchScript();
  try {
    console.log(`\n→ running: sh download_dependencies.sh ${SCRIPT_ARGS.join(" ")}\n`);
    await run("sh", [script.path, ...SCRIPT_ARGS], { cwd: home });
  } finally {
    await rm(script.dir, { recursive: true, force: true });
  }

  // Verify with the binding itself rather than trusting the script's exit code.
  const { checkDependencies } = await import("docling.rs");
  const status = checkDependencies({ dir: home });
  console.log(
    `\n${status.ready ? "ready" : "NOT READY"}  home=${status.home}  missing=${JSON.stringify(status.missing)}`,
  );
  console.log(
    `  pdfium=${status.pdfium} layout=${status.layout} ocr=${status.ocr} ` +
      `ocrDet=${status.ocrDet} tableformer=${status.tableformer} chunkTokenizer=${status.chunkTokenizer}`,
  );

  if (!status.ready) {
    console.error("\nModels are still incomplete — see `missing` above.");
    process.exitCode = 1;
  }
}

await main();
