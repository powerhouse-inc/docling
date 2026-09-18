# Repair-path fixtures

Two hand-built PDFs, ~1 KB each, that exist to keep one branch of `server.ts` under test: **the `FormatError` repair path**.

They are deliberately malformed in ways that tolerant readers accept and pdfium does not. That combination is the whole point — a file every reader rejects only proves your error handling, not your repair.

| fixture | what is wrong with it | which rewriter cures it |
|---|---|---|
| `dangling_kid.pdf` | the page tree lists `/Kids [3 0 R 42 0 R]` and object `42` does not exist | **`qpdf`** — `--linearize` drops the broken reference |
| `count_mismatch.pdf` | the `/Pages` node declares `/Count 7` while `/Kids` holds two pages | **`gs`** — qpdf preserves the wrong `/Count`, so it still refuses |

Both are 2-page, A5, Helvetica, with the text `Hello` — the same generator, one mutation apart.

## What the tools actually say (measured, not assumed)

| reader | `count_mismatch.pdf` | `dangling_kid.pdf` |
|---|---|---|
| `pdfinfo` | reads it, **2 pages** | reads it, **2 pages** |
| `qpdf --check` | **exit 0, with a warning** (outline loop) | **exit 0, with warnings** — *"Pages tree includes non-dictionary object; ignoring"* plus the outline loop |
| `docling.rs` (pdfium) | **refused at load** | **refused at load** |

So the honest claim is **"tolerated by other readers, refused outright by pdfium"** — not "clean to every other tool". `qpdf` reports the `dangling_kid` defect and works around it.

**A control, because these files are hand-built:** every variant from this generator — including `baseline.pdf`, the unmutated one — draws the same qpdf *"Loop detected loop in /Outlines tree"* warning from the minimal outline it writes. Since `baseline.pdf` converts **fine** (19 chars), that warning is a generator artifact and **not** the trigger. The difference between `baseline` and the two fixtures is exactly the mutation, which is what makes them usable as a reproducer.

## Verifying the path

With the service running (`node src/server.ts`) and models installed:

```bash
cd src
for f in fixtures/*.pdf; do
  printf "%-22s " "$(basename "$f")"
  curl -s -X POST "http://127.0.0.1:5007/convert?filename=$(basename "$f")" \
    --data-binary "@$f" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('normalised=' + str(d.get('normalised')), '| chunks', len(d.get('chunks', [])))"
done
```

Expected — and measured on 2026-09-17:

```
dangling_kid.pdf       normalised=qpdf | chunks 0
count_mismatch.pdf     normalised=gs   | chunks 0
```

`chunks 0` is correct for these: they hold one word of text and no headings.

## Why two fixtures and not one

Because the first version of the repair failed the second one. It tried `qpdf`, accepted an **exit code of 0** as proof the rewrite had worked, and returned the still-broken file to the converter — so `count_mismatch.pdf` answered `500` with a raw pdfium error, while `gs` was sitting right there able to cure it:

```
original       THREW  PdfiumLibraryInternalError
qpdf rewrite   THREW  PdfiumLibraryInternalError   ← exit code 0, no cure
gs rewrite     OK     19 chars
```

The repair loop now converts after each rewrite and takes the first that works, and answers `415` (not `500`) when none does. **Keep both fixtures: `dangling_kid` covers the first rewriter, `count_mismatch` covers the fallback.**
