import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The v1 surface against a real socket, because the point of it is wire
 * compatibility with a client this repo does not contain — translating in
 * isolation proves the mapping, not the route.
 *
 * Markdown is the input throughout: it converts in milliseconds and, unlike a
 * PDF, needs none of the ~700 MB of models, so this runs anywhere.
 */
const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
const PORT = 5317;
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | undefined;

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy");
}

function source(markdown: string, filename = "note.md") {
  return {
    kind: "file",
    filename,
    base64_string: Buffer.from(markdown, "utf8").toString("base64"),
  };
}

/** Just the parts these tests read. */
type V1Body = {
  status?: string;
  document?: {
    filename?: string | null;
    md_content?: string;
    json_content?: unknown;
    html_content?: unknown;
  };
  errors?: unknown[];
  processing_time?: number;
  error?: string;
};

async function postV1(body: unknown) {
  const res = await fetch(`${BASE}/v1/convert/source`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as V1Body };
}

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CONVERT_SERVICE_PORT: String(PORT),
      CONVERT_SERVICE_HOST: "127.0.0.1",
    },
    stdio: "ignore",
  });
  await waitForHealth();
}, 40_000);

afterAll(() => {
  child?.kill("SIGTERM");
});

describe("GET /version", () => {
  // piece-docling's connection check reads this as the connection's label and
  // fails the whole connection without it — it is the smallest piece of the
  // compatibility surface and the one that gates everything else.
  it("reports a docling-serve version", async () => {
    const res = await fetch(`${BASE}/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["docling-serve"]).toBe("string");
    expect(body["docling-serve"]).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("POST /v1/convert/source", () => {
  it("converts a file source and answers in the ConvertDocumentResponse shape", async () => {
    const { status, body } = await postV1({
      sources: [source("# Title\n\nHello there.")],
      options: { to_formats: ["md"] },
      target: { kind: "inbody" },
    });

    expect(status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.document?.md_content).toContain("Hello there.");
    expect(body.document?.filename).toBeTruthy();
    // Only the asked-for formats are populated, as upstream does.
    expect(body.document?.json_content).toBeNull();
    expect(body.document?.html_content).toBeNull();
    expect(body.errors).toEqual([]);
    expect(typeof body.processing_time).toBe("number");
  }, 60_000);

  it("populates json_content when json is requested", async () => {
    const { body } = await postV1({
      sources: [source("# Title\n\nHello.")],
      options: { to_formats: ["md", "json"] },
    });
    expect(body.document?.json_content).not.toBeNull();
  }, 60_000);

  // Accepting an option and quietly ignoring it is the failure this guards:
  // the caller is told, in the response, which of its settings did nothing.
  it("reports ignored options as partial_success rather than swallowing them", async () => {
    const { status, body } = await postV1({
      sources: [source("# Title\n\nHello.")],
      options: { to_formats: ["md"], table_mode: "accurate", page_range: [1, 2] },
    });

    expect(status).toBe(200);
    expect(body.status).toBe("partial_success");
    const named = JSON.stringify(body.errors);
    expect(named).toContain("table_mode");
    expect(named).toContain("page_range");
    // The conversion still happened.
    expect(body.document?.md_content).toContain("Hello.");
  }, 60_000);

  it("rejects a body with no sources", async () => {
    const { status, body } = await postV1({ sources: [] });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/sources/i);
  });

  it("rejects more than one source instead of dropping the rest", async () => {
    const { status, body } = await postV1({
      sources: [source("# a"), source("# b")],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/one source/i);
  });

  it("rejects a target it cannot deliver to", async () => {
    const { status, body } = await postV1({
      sources: [source("# a")],
      target: { kind: "s3" },
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/inbody/i);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await fetch(`${BASE}/v1/convert/source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("the existing routes are untouched", () => {
  it("still converts through POST /convert", async () => {
    const res = await fetch(`${BASE}/convert?filename=note.md`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "# Title\n\nStill here.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The service's own shape, not the v1 one.
    expect(String(body.markdown)).toContain("Still here.");
    expect(body.document).toBeUndefined();
  }, 60_000);

  it("still answers /health and /", async () => {
    expect((await fetch(`${BASE}/health`)).status).toBe(200);
    const root = (await (await fetch(`${BASE}/`)).json()) as Record<string, unknown>;
    expect(root.service).toBe("vault-convert");
  });
});
