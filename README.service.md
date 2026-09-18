# docling-serve

A local document-conversion service over [`docling.rs`](https://github.com/docling-project/docling.rs), used by the Knowledge Vault's `subgraphs/convert` proxy.

Anything the vault can read goes in; markdown plus docling chunks come out. It is a **separate process on purpose**: once it has converted a PDF the binding keeps hundreds of megabytes of ONNX weights resident, and the Switchboard should not carry that.

```
knowledge-vault app ─▶ Switchboard ─▶ subgraphs/convert ─▶ this service
```

## Run it

```bash
bun install                      # pulls the docling.rs binding (optionalDependency)
node scripts/docling-serve/server.ts
# vault-convert listening on http://127.0.0.1:5007 (node v26.8.1)
```

Runs on **Node and Bun** — the vault is deployed with Node, so the service uses `node:http` and `node:child_process`, both of which Bun implements too.

| Variable               | Default     | Meaning                            |
| ---------------------- | ----------- | ---------------------------------- |
| `CONVERT_SERVICE_PORT` | `5007`      | Listen port (`PORT` also honoured) |
| `CONVERT_SERVICE_HOST` | `127.0.0.1` | Listen host                        |
| `CONVERT_MAX_BYTES`    | `268435456` | Request body cap (256 MB)          |
| `DOCLING_RS_HOME`      | process CWD | Where `.models` / `.pdfium` live   |

Point the vault at it with `CONVERT_SERVICE_URL=http://127.0.0.1:5007` (see `powerhouse.manifest.json`).

## Endpoints

### `GET /health`

Two independent states, because they fail differently:

```jsonc
{
  "ok": true,
  "backend": "docling.rs",
  "runtime": "node v26.8.1",
  "ready": true,
  "missing": [], // models present?
  "modelsDir": "/var/lib/vault-models",
  "modelsLoaded": false, // warm pipeline created yet?
  "formats": [
    /* 29 format ids */
  ],
}
```

`ready: false` means the models have not been fetched — declarative formats still convert, `pdf`/`image` return `415`. `ok: false` with `503` means the binding itself is missing.

### `POST /convert?filename=<name>`

Raw body is the document; the filename (an extension is enough) selects the parser.

```bash
curl -s -X POST "http://127.0.0.1:5007/convert?filename=report.pdf" \
  --data-binary @report.pdf -o out.json
```

```jsonc
{
  "markdown": "…",
  "chunks": [
    {
      "text": "…",
      "headings": ["Chapter 1"],
      "contextualized": "…",
      "docItems": ["#/texts/3"],
    },
  ],
  "format": "pdf",
  "inputName": "report.pdf",
  "timings": { "convertMs": 1204, "chunkMs": 986, "totalMs": 2340 },
  "backend": "docling.rs",
  "normalised": null, // "qpdf" | "gs" when a PDF had to be rewritten
  "ocr": null, // "forced" when the text layer was glyph soup and every page was OCR'd; "requested" with ?ocr=1
}
```

See _How a PDF gets read_ below for the OCR fallback ladder; `?ocr=1` asks for OCR regardless of the budget.

| Status | When                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | No `filename`, or an empty body                                                                                                                                   |
| `413`  | Body over `CONVERT_MAX_BYTES`                                                                                                                                     |
| `415`  | A `pdf`/`image` request while the models are missing (`missing[]` in the body), an unreadable document, or a garbled text layer with no OCR model to fall back to |
| `503`  | The `docling.rs` binding is not installed                                                                                                                         |
| `500`  | Anything else, with the message                                                                                                                                   |

## How a PDF gets read — cheapest rung first, nothing installed

The service detects what the machine has and reports it in `/health` (`capabilities`, `ocrEngine`, `autoOcrBudgetSeconds`); the response says which rung produced the text (`textSource`, `ocr`).

| rung                       | when                                                                                                                                             | needs                                       | cost (measured 2026-09-18)                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 docling plain pass       | always first — **this already OCRs image-only pages** (measured: a 2-page scan read at 4.2 s/page, 1.8 % garble)                                 | the binding + models                        | seconds                                                                                                                                                                             |
| 1 pdf.js text layer        | pdfium returned glyph soup but the text layer is fine (Type 3 fonts under custom encodings)                                                      | nothing — pure npm                          | 0.4 s / 19 pages; headings and paragraphs rebuilt from type size and line gaps (`textlayer.mjs`); no tables or bullets — the response carries `ocrOffer` so the UI can offer rung 2 |
| 2 Tesseract via `ocrmypdf` | docling's own pass came back garbled _and_ pdf.js finds no words either (a scan the built-in OCR misread, or a lying layer no reader can decode) | `ocrmypdf` + `tesseract` on PATH (detected) | ~2.6 s/page single-threaded, parallel across `CONVERT_OCR_JOBS`                                                                                                                     |
| 3 docling's bundled OCR    | same, without Tesseract                                                                                                                          | the models                                  | 8.6 s/page; automatic under `CONVERT_AUTO_OCR_SECONDS` (60), **offered** above it (`needsOcr` in the response, re-request with `?ocr=1`)                                            |
| —                          | none of the above can read it                                                                                                                    | —                                           | `415` with `capabilities` in the body                                                                                                                                               |

The decision is `routing.mjs`, a pure function with its own tests. `?ocr=1` skips the budget. **One conversion runs at a time**: a second request gets `503 CONVERSION_BUSY` at once (the client treats it as retry-later). The service is spawned under `nice -n 10` by the subgraph's autostart, and OCR helpers under `nice` too, so the rest of the machine keeps priority.

For a server, `Dockerfile` in this directory bakes every rung into one glibc container; point the Switchboard at it with `CONVERT_SERVICE_URL`.

## The models (~700 MB) are not fetched for you

A fresh clone/boot converts `md`, `html`, `docx`, `csv`, `xlsx`, `pptx`, `epub` and the rest **immediately** — those need no models at all (HTML → markdown measures 1 ms). Only `pdf` and `image` need the download:

```bash
node scripts/docling-serve/fetch-models.mjs
DOCLING_RS_HOME=/var/lib/vault-models node scripts/docling-serve/fetch-models.mjs
```

It prints the upstream script's size and sha256 before running it, fetches with `--no-asr`, then verifies with `checkDependencies()` and exits non-zero if anything is still missing. Re-running is safe.

Deliberately **not** done at `postinstall` and **not** at start-up: it would make boot network-bound, and loading the models costs ~1.36 GB resident under Node (~2.78 GB under Bun).

## Notes that come from measurement

- **The warm `Pipeline` is for `pdf` and `image` only** — its typings say so. Declarative formats go through the per-call functions and need no models. Routing a `.docx` through the pipeline would be wrong, not just wasteful.
- **One process serialises PDF conversions.** The binding queues overlapping calls on one `Pipeline` (the models are mutable sessions), so throughput comes from warm models and extra _processes_, not from concurrent requests. Scale with replicas behind `CONVERT_SERVICE_URL`.
- **It chunks with `chunkFileAsync`** — measured 1.6× cheaper to chunk the JSON we already converted, but rejected: the two paths disagree on _real content_. On the sample PDF they agree on chunk count (55 each) and on every heading path, then diverge inside the education table, where the JSON path returns the cells associated differently. Correctness won. **The price is scale-dependent:** models are not reloaded per call, so on a 2-page CV it is invisible (3.0 s end to end), but on a 238-page book the chunk half costs a second full conversion — 160.6 s converting + 172.7 s chunking, where the rejected path would have saved ~170 s. Roughly 2× the work on large documents, once per ingest.
- **The first PDF after a cold start is the slowest.** The warm `Pipeline` needs one conversion to warm up: its first markdown call measured **1 751 ms** against 1 003 ms on the second, and `chunkFileAsync` settles at ~1 550 ms. So a just-started service is not a good benchmark, and a progress indicator should not extrapolate from it.
- **Some valid PDFs make pdfium throw `FormatError`** — a 238-page book that `pdfinfo` reads fine and that is not encrypted. Those are rewritten and retried, and **the response says which tool worked** (`"normalised": "qpdf" | "gs"`). Two things learned the hard way, both now covered by committed fixtures in `fixtures/`:
  - **"The tool exited 0" is not the test — "the rewritten file converts" is.** On `fixtures/count_mismatch.pdf` (a page tree declaring more pages than it has), `qpdf --linearize` exits 0 and leaves the file just as refused, while `gs` rebuilds the tree and cures it. The loop now converts after each rewrite and takes the first that works, then answers **`415`, not `500`**, if neither does.
  - The class of failure is wider than `FormatError`: the fixtures throw `PdfiumLibraryInternalError(Unknown)`, the book threw `…(FormatError)`. The trigger matches the whole `PdfiumLibraryInternalError` family, which is why it is not a literal string comparison on `FormatError`.
  - **Caveat:** the original book that motivated this now converts without any rewrite, under Node and Bun alike, so the fixtures — not that book — are what keeps this path honest (design spec §5.1).
- **A docling chunk is not a vault source.** Chunks are tokenizer-shaped; turning them into sections is the vault's job, above this boundary.
