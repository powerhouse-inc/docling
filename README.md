# docling-service

Document conversion over [`docling.rs`](https://www.npmjs.com/package/docling.rs), as a small HTTP service.

The Powerhouse Knowledge Vault talks to it through its `convert` subgraph and knows it only by a URL:

```
CONVERT_SERVICE_URL=http://<host>:5011
```

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
