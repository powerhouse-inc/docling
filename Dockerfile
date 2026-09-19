# The document-conversion service as its own container.
#
# It is deliberately NOT a Powerhouse reactor package and NOT part of the vault
# image: `docling.rs` publishes only `linux-x64-gnu`, `linux-arm64-gnu` and
# `win32-x64-msvc` builds — there is no musl build — so it cannot load inside
# the alpine Switchboard image. It is also its own process for a second reason:
# the binding keeps ~1.36 GB of ONNX weights resident once it has converted a
# PDF, and the Switchboard should not carry that.
#
#   docker build -t docling-service .
#   docker run -p 5011:5011 -v docling-models:/models -e DOCLING_RS_HOME=/models docling-service
#   # once, into the volume — ~700 MB, not fetched at build or boot:
#   docker run --rm -v docling-models:/models -e DOCLING_RS_HOME=/models docling-service npm run fetch-models
#
# Then point the vault's Switchboard at it: CONVERT_SERVICE_URL=http://<host>:5011
#
# The base must be **trixie, not bookworm**. `docling.rs` >= 1.58 is linked
# against GCC 14's libstdc++ and needs `_M_replace_cold`, which first appears in
# libstdc++.so.6.0.33. Debian bookworm ships 6.0.30, so `node:24-slim` builds
# cleanly and then fails at run time with `undefined symbol: _ZNSt7__cxx11...`,
# which surfaces only as `/health -> {"ok": false}`. Verified, not assumed.
FROM node:24-trixie-slim AS docling

# Rung 2 (Tesseract via ocrmypdf) and the PDF repair tools qpdf/ghostscript,
# which rescue PDFs that pdfium refuses. Poppler arrives with ocrmypdf; add more
# tesseract-ocr-<lang> packages for other languages.
#
# `curl` is not optional: docling's own download_dependencies.sh checks for it
# and exits 1 with "error: curl is required", so without it `npm run fetch-models`
# fails and the service is stuck at ready:false — able to convert docx/html/md
# but never a PDF. `tar` and `gzip` the same script needs are already in the base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ocrmypdf tesseract-ocr tesseract-ocr-eng ghostscript qpdf ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree. Scripts are
# skipped for the install and the one native binding is rebuilt explicitly.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts \
  && npm rebuild docling.rs

COPY src ./src

# The models live on a volume, not in the image: they are ~700 MB and change on
# their own cadence. DOCLING_RS_HOME is what both the server and fetch-models
# read; without it they fall back to the app root, which is ephemeral.
#
# CONVERT_HEARTBEAT_MS keeps a slow conversion's connection alive through a
# reverse proxy: nginx's proxy_read_timeout defaults to 60 s and most cloud load
# balancers to the same, while a large PDF takes minutes. 15 s is comfortably
# inside every common default. Set it to 0 when nothing proxies this service.
ENV DOCLING_RS_HOME=/models \
    CONVERT_SERVICE_HOST=0.0.0.0 \
    CONVERT_SERVICE_PORT=5011 \
    CONVERT_OCR_JOBS=4 \
    CONVERT_AUTO_OCR_SECONDS=60 \
    CONVERT_HEARTBEAT_MS=15000
VOLUME ["/models"]
EXPOSE 5011

# `ok` means the backend loaded; `ready` additionally means the models are on
# disk. Health here is the former: a service that converts docx/html/md but has
# no PDF models yet is working, and the vault's /convert/health reports the
# difference rather than hiding it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONVERT_SERVICE_PORT||5011)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

# `nice` so conversion yields to whatever else shares the host.
CMD ["nice", "-n", "10", "node", "src/server.ts"]
