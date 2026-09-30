# docling-service

Document conversion over [`docling.rs`](https://www.npmjs.com/package/docling.rs), as a small HTTP service.

The Powerhouse Knowledge Vault talks to it through its `convert` subgraph and knows it only by a URL:

```
CONVERT_SERVICE_URL=http://<host>:5011
```


## docling-serve v1 compatibility

Powerhouse's workflow piece for docling (`@powerhousedao/piece-docling`) speaks docling-serve's v1 API, so this service answers a subset of it:

| Route | Notes |
| --- | --- |
| `GET /version` | Reports this service's version as `docling-serve`; the piece's connection check reads it as the connection label |
| `POST /v1/convert/source` | `{ sources: [one file or http source], options, target: { kind: "inbody" } }` → `ConvertDocumentResponse` |

### Conversion options

Everything `docling.rs` accepts is reachable, on `POST /convert` as query parameters and on `/v1/convert/source` through docling-serve's `options` block (whose names are translated onto the binding's):

| Group | Query parameters |
| --- | --- |
| OCR | `ocr=1` (force full-page), `skipOcr`, `forceFullPageOcr`, `ocrLang`, `ocrMode`, `ocrScale` |
| Layout | `headingHierarchy`, `noTextPanels`, `ebcdicLayout`, `pages` |
| Tables | `compactTables`, `skipEmptyCells` |
| Enrichment | `doCodeEnrichment`, `doFormulaEnrichment`, `doPictureClassification` |
| ASR | `asrModel`, `asrLang`, `videoFrames` (needs the ASR models; see below) |
| VLM | `pipeline`, `vlmEndpoint`, `vlmModel`, `vlmApiKey`, `vlmPrompt`, `vlmMaxTokens` |
| Output | `to`, `imageMode`, `pageBreakPlaceholder`, `listAttachments`, `fetchImages`, `strict` |
| Chunker | `chunker`, `tokenizer`, `maxTokens`, `mergePeers` |

From the v1 side: `force_ocr`, `do_ocr` (false → `skipOcr`), `ocr_lang`, `page_range`, `image_export_mode`, `do_code_enrichment`, `do_formula_enrichment`, `do_picture_classification`, `abort_on_error` (→ `strict`) and `pipeline` are translated. Anything else — `table_mode`, `pdf_backend`, `document_timeout` — has no equivalent and is reported in `errors[]` with `status: "partial_success"` rather than accepted in silence.

Two behaviours worth knowing. **A request carrying conversion options does not use the warm pipeline**, which ignores per-call options — it costs model reuse to be obeyed. And **chunks are then cut from the same converted document** rather than a fresh default conversion, because `chunkFileAsync` re-converts with defaults and would otherwise chunk a different document from the one the markdown came from; that is the JSON-chunking path, slightly less faithful on table cells, which is the better of the two errors.

ASR options are accepted but the models are not fetched by default (`--no-asr`); a build that wants them has to fetch them and have `ffmpeg` present.

`/convert`, `/health` and `/progress/:job` are unchanged — the v1 routes translate onto them rather than reimplementing anything, so the OCR ladder, the normalising retries, figures and the extraction score all still apply.

What it deliberately does not do:

- **One source per request.** docling-serve batches up to three; this service converts one document at a time.
- **No async job routes.** `/v1/status/poll` and `/v1/result` need a store of finished conversions; here `POST /convert` holds the connection and `/progress/:job` only watches one already running.
- **No chunk route.** Chunks come back with every conversion; ask for `to_formats: ["md","json"]` and they arrive as `document.json_content`.
- **Most conversion options are ignored, and say so.** This service reads OCR, tables and layout from the file itself, so `table_mode`, `page_range`, `pdf_backend`, the enrichment flags and the rest have no equivalent. An option it cannot honour comes back in `errors[]` with `status: "partial_success"` rather than being accepted in silence — only `to_formats`, `do_ocr` and `force_ocr` do anything.

A caller that wants this service's own richer answer — the extraction score, which OCR rung read the file, the figures — should use `POST /convert` directly, or the `@powerhousedao/piece-convert` workflow piece. The v1 response shape has nowhere to put any of it.

## Why it is its own deployable

**It cannot live in the Switchboard image.** `docling.rs` publishes `linux-x64-gnu`,
`linux-arm64-gnu` and `win32-x64-msvc` — there is no musl build, and the Switchboard
image is `node:24-alpine`. This image is `node:24-slim` (glibc) for that reason.

**It should not, either.** Once it has converted a PDF the binding keeps ~1.36 GB of
ONNX weights resident, by design — that warmth is what makes the second conversion
fast. A Switchboard replica should not carry it, and throughput here comes from extra
*processes*: one instance serialises PDF conversions, because the models are mutable
sessions.

## Run it

```bash
docker build -t docling-service .
docker run -p 5011:5011 -v docling-models:/models docling-service
```

Conversion of `md`, `html`, `docx`, `csv`, `xlsx`, `pptx`, `epub` and the rest works
immediately. **`pdf` and `image` need ~700 MB of models**, fetched once into the volume:

```bash
docker run --rm -v docling-models:/models docling-service npm run fetch-models
```

That is deliberately not done at build or boot — it would make image size or start-up
network-bound, and `/health` reports the difference rather than hiding it.

Locally, without Docker:

```bash
bun install
npm run fetch-models     # optional, for pdf/image
npm start
```

## `GET /health`

Two independent states, because they fail differently:

```jsonc
{
  "ok": true,           // the native binding loaded
  "backend": "docling.rs",
  "ready": false,       // ...but the models are not on disk yet
  "missing": ["pdfium", "layout_heron.onnx"],
  "modelsDir": "/models",
  "modelsLoaded": false, // warm pipeline not created yet
  "formats": [ /* 29 ids */ ]
}
```

`ok: false` means the backend is unavailable — the service is broken. `ok: true,
ready: false` means it converts everything except PDFs and images, which is a
working service with a pending download. The vault surfaces both.

## Configuration

| Variable                   | Default     | Meaning                                  |
| -------------------------- | ----------- | ---------------------------------------- |
| `CONVERT_SERVICE_PORT`     | `5007`      | Listen port (`PORT` also honoured)       |
| `CONVERT_SERVICE_HOST`     | `127.0.0.1` | Listen host (the image sets `0.0.0.0`)   |
| `CONVERT_MAX_BYTES`        | `268435456` | Request body cap (256 MB)                |
| `DOCLING_RS_HOME`          | repo root   | Where `.models` / `.pdfium` live         |
| `CONVERT_OCR_JOBS`         | `4`         | ocrmypdf parallelism                     |
| `CONVERT_AUTO_OCR_SECONDS` | `60`        | Budget before OCR is abandoned           |
| `CONVERT_IDLE_RELEASE_MS`  | unset       | Release the warm pipeline after idle time |
| `CONVERT_HEARTBEAT_MS`     | `15000`     | Keep-alive byte interval; `0` disables   |

## Sizing

Measured on a 238-page, 16.6 MB book (`quality.coverage 0.955`, 972 chunks):

| | |
| --- | --- |
| Idle, no conversion yet | **52 MB** |
| Warm models, small PDF | **1.13 GB** |
| Peak during the book | **9.6 GB** |
| Wall clock | **334 s** (155 s converting + 178 s chunking) |

The 1.13 GB figure quoted elsewhere is the *idle* cost of keeping models
resident. The working set for a large document is several times that, and it
scales with the document rather than with traffic. **A 2 GB container limit
OOMs mid-book, and the failure looks like a dropped connection** — set the limit
around 12 GB with a much smaller request.

Concurrency does not multiply it: one instance serialises PDF conversions
because the models are mutable sessions, so throughput comes from replicas, and
each replica needs its own headroom.

## Running behind a reverse proxy

Two proxy defaults break document ingestion, and both fail as something else.

**Idle timeouts.** A 238-page book takes minutes; nginx's `proxy_read_timeout`,
most cloud load balancers and Cloudflare cut the connection at 60–100 s. The
caller then sees a network error that says nothing about the document.

The service defends itself: during a conversion it writes a single space every
`CONVERT_HEARTBEAT_MS`, and proxies reset their read timer on any upstream byte.
JSON ignores leading whitespace, so a client calling `response.json()` needs no
knowledge of it. The trade: the first heartbeat commits the status to `200`, so
an error after that point arrives as `200` with `deferredStatus` in the body
carrying the code it would have been. Errors before the first interval — nearly
all of them, since bad input is rejected in milliseconds — are unaffected.

**Body size.** nginx's `client_max_body_size` defaults to **1 MB**, so almost
every real document is rejected with a 413 before the service sees it. Raise it
to at least the vault's 30 MB cap.

`deploy/nginx.conf` is a working reference with both settings, the equivalents
for Envoy, HAProxy, ALB, GCP LB, Traefik and ingress-nginx, and a note on why a
partial TLS chain surfaces as `ok: false` rather than a certificate error.

## Development

```bash
bun install
bun run test     # 62 tests, no models required
bun run tsc
bun run lint
```

The tests cover the pure modules — figure extraction, table recovery, the text
layer, OCR routing and quality scoring — and need neither the native binding nor
the models. `src/fixtures/` holds the PDFs that keep the repair path honest.

Detailed design notes, including what was measured rather than assumed, are in
[`README.service.md`](README.service.md).
