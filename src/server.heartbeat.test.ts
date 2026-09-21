import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The heartbeat is the one thing in this service that exists purely for the
 * network between it and its caller, so it is worth testing against a real
 * socket rather than a mock: what matters is the bytes on the wire and whether
 * an ordinary JSON client still parses them.
 *
 * `server.ts` listens on import and exports nothing, so the server is spawned.
 * `CONVERT_HEARTBEAT_MS` is set absurdly low so a millisecond-fast markdown
 * conversion still emits one; at the 15 s default nothing here would.
 */
const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
const PORT = 5313;
const BASE = `http://127.0.0.1:${PORT}`;
const PORT_NOHB = 5314;
const BASE_NOHB = `http://127.0.0.1:${PORT_NOHB}`;

let child: ChildProcess | undefined;
let childNoHb: ChildProcess | undefined;

async function waitForHealth(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, {
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

function start(port: number, heartbeatMs: string): ChildProcess {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CONVERT_SERVICE_PORT: String(port),
      CONVERT_SERVICE_HOST: "127.0.0.1",
      CONVERT_HEARTBEAT_MS: heartbeatMs,
    },
    stdio: "ignore",
  });
}

beforeAll(async () => {
  // 20 ms, so a body trickled over ~180 ms produces several heartbeats.
  child = start(PORT, "20");
  childNoHb = start(PORT_NOHB, "0");
  await Promise.all([waitForHealth(BASE), waitForHealth(BASE_NOHB)]);
}, 40_000);

afterAll(() => {
  child?.kill("SIGTERM");
  childNoHb?.kill("SIGTERM");
});

/**
 * A body delivered in slow dribs, so the server spends a known amount of time
 * waiting on the socket. Conversion speed cannot be used as the clock: markdown
 * converts in ~3 ms, which beats any sane heartbeat interval. The upload itself
 * is also the honest case — a big file over a slow link is exactly when an idle
 * timeout fires with nothing yet written.
 */
function trickle(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream({
    async pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(encoder.encode(next));
    },
  });
}

async function slowConvert(filename: string) {
  const res = await fetch(
    `${BASE}/convert?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      body: trickle(["# Title\n", "\n", "Body text.\n"], 60),
      // Required by undici whenever the body is a stream. @types/node >= 24
      // declares `duplex` on RequestInit, so the intersection cast that used
      // to be needed here is now flagged as an unnecessary assertion.
      duplex: "half",
    },
  );
  return { res, text: await res.text() };
}

describe("heartbeat", () => {
  it("keeps the connection busy without breaking JSON parsing", async () => {
    const { res, text } = await slowConvert("hb.md");

    expect(res.status).toBe(200);
    // Leading whitespace is what a proxy sees as traffic; JSON ignores it.
    expect(text).toMatch(/^\s/);
    const parsed = JSON.parse(text) as { format: string; markdown: string };
    expect(parsed.format).toBe("md");
    expect(parsed.markdown).toContain("Title");
  });

  it("switches the response to chunked, since the length is unknown", async () => {
    const { res } = await slowConvert("hb2.md");

    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  // A request rejected before any work starts never heartbeats, so the status
  // code still carries the outcome — which is the common case for bad input.
  it("leaves fast rejections with their real status code", async () => {
    const res = await fetch(`${BASE}/convert`, { method: "POST", body: "x" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeDefined();
    expect(body.deferredStatus).toBeUndefined();
  });

  // Without a proxy in front there is no reason to pay for chunking, and the
  // switch has to actually switch.
  it("is off when the interval is zero", async () => {
    const res = await fetch(`${BASE_NOHB}/convert?filename=plain.md`, {
      method: "POST",
      body: "# Plain\n",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).not.toBeNull();
    expect(await res.text()).toMatch(/^\{/);
  });
});
