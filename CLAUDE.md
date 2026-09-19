# docling-service

An HTTP document-conversion service over `docling.rs`. **Not** a Powerhouse
reactor package: no document models, editors, processors or subgraphs. The
Knowledge Vault reaches it by URL only (`CONVERT_SERVICE_URL`), through its own
`convert` subgraph.

## Two constraints that decide the shape of everything here

**The base image must be `node:24-trixie-slim`, not `-slim`/bookworm.**
`docling.rs` >= 1.58 is linked against GCC 14's libstdc++ and needs
`_M_replace_cold`, which first appears in `libstdc++.so.6.0.33`. Bookworm ships
`6.0.30`. A bookworm build **succeeds**, then fails at run time with
`undefined symbol: _ZNSt7__cxx11...` — and the only outward sign is
`GET /health` returning `{"ok": false}`. Verify a base change by running the
container and reading `/health`, never by a green build.

**A conversion holds one HTTP connection for its whole duration.** There is no
job-and-poll API: `POST /convert` returns the result, and `GET /progress/:job`
only reports on a conversion already in flight. A big PDF therefore keeps the
socket open for minutes, which every common proxy default kills at 60–100 s. The
service writes a space every `CONVERT_HEARTBEAT_MS` so proxies see traffic; the
cost is that the first heartbeat fixes the status at `200`, so later errors carry
`deferredStatus` in the body instead. Anything that changes when the response
starts must keep that contract — and note `sendJson` is the single choke point
where it is enforced, which is why every error path already works with it.

**It cannot live in the Switchboard image at all.** `docling.rs` publishes
`linux-x64-gnu`, `linux-arm64-gnu` and `win32-x64-msvc` — no musl build — and
the Switchboard image is alpine. That is why this repository exists.

## Layout

```
src/server.ts        the service: GET /health, GET /progress/:id, POST /convert
src/fetch-models.mjs one-off ~700 MB model download into DOCLING_RS_HOME
src/*.mjs            pure modules — figures, tables, textlayer, routing, quality
src/fixtures/        PDFs that keep the pdfium repair path honest
Dockerfile           single `docling` target, what CI builds
```

`src/server.ts` resolves `PACKAGE_ROOT` as `..` from its own file. If files move
between directory depths, that constant and the same one in `fetch-models.mjs`
must move with them — it is the default for `DOCLING_RS_HOME`.

## Checks

```bash
bun install
bun run test    # 62 tests; needs neither the native binding nor the models
bun run tsc
bun run lint
```

The tests deliberately cover only the pure modules, so they run anywhere —
including macOS, where `docling.rs` has no build at all. Anything touching the
binding has to be verified in the container.

## Models

`md`, `html`, `docx`, `csv`, `xlsx`, `pptx`, `epub` and the rest convert with no
models. Only `pdf` and `image` need the ~700 MB download, which is **not** done
at build or boot — it would make the image or start-up network-bound. `/health`
reports `ready: false` plus a `missing` list until they are present, and that is
a working service, not a broken one.

## Releasing

`.github/workflows/publish-image.yml` builds the `docling` target and pushes to
`cr.vetra.io` (Harbor) and GHCR. It publishes an **image**, not an npm package.
