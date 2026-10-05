/**
 * server.ts -- tiny read-only HTTP + SSE server, bound to 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PRICING_NOTE, ESTIMATES, OPENAI_PRICING_NOTE } from "./pricing.js";
import type { Radar } from "./store.js";
import { parseWindow } from "./topics.js";

export const HOST = "127.0.0.1";

/** Agent keys are "main" or a provider's agent id; never used to build paths (providers look them up). */
const AGENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};

/**
 * Static files: a flat name inside public/ with a known extension. The regex admits no slashes or
 * dots besides the extension, so a request can never leave public/.
 */
export function staticFile(path: string): { file: string; type: string } | undefined {
  if (path === "/") return { file: "index.html", type: TYPES["html"] as string };
  const m = /^\/([a-z0-9][a-z0-9-]{0,63})\.(html|js|css|svg)$/.exec(path);
  if (!m) return undefined;
  const type = TYPES[m[2] as string];
  return type ? { file: `${m[1]}.${m[2]}`, type } : undefined;
}

const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // Google Fonts (Inter, JetBrains Mono) is the only third party; the UI falls back to system fonts offline.
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SEC_HEADERS, "Content-Type": type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

/** DNS-rebinding guard: only accept requests addressed to a loopback host name. */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function createRadarServer(radar: Radar): Server {
  const clients = new Set<ServerResponse>();

  let pending: Set<string> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const flush = (): void => {
    timer = undefined;
    const changed = pending ? [...pending] : [];
    pending = undefined;
    if (clients.size === 0) return;
    const payload = `event: update\ndata: ${JSON.stringify({ ...snapshot(radar), changed })}\n\n`;
    for (const c of clients) c.write(payload);
  };
  radar.on("change", (ids: string[]) => {
    pending ??= new Set();
    for (const id of ids) pending.add(id);
    timer ??= setTimeout(flush, 300);
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 20_000);
  heartbeat.unref();

  const server = createServer((req, res) => {
    handle(radar, clients, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    for (const c of clients) c.end();
  });
  return server;
}

function snapshot(radar: Radar): Record<string, unknown> {
  return { now: Date.now(), loading: radar.loading, sessions: radar.listSessions(), machine: radar.machine(), providers: radar.providerStatus() };
}

async function handle(radar: Radar, clients: Set<ServerResponse>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hostAllowed(req.headers.host)) return sendJson(res, 403, { error: "forbidden host" });
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "read-only: GET only" });

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  const st = staticFile(path);
  if (st) {
    try {
      return send(res, 200, st.type, await readFile(join(PUBLIC_DIR, st.file), "utf8"));
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
  }

  if (path === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      loading: radar.loading,
      home: radar.home,
      userHome: homedir(),
      sessions: radar.listSessions().length,
      providers: radar.providerStatus().map((p) => p.id),
    });
  }

  if (path === "/api/providers") {
    return sendJson(res, 200, { now: Date.now(), providers: radar.providerStatus() });
  }

  if (path === "/api/pricing") {
    return sendJson(res, 200, { note: CLAUDE_PRICING_NOTE, unit: "USD / 1M tokens", estimates: ESTIMATES, estimatesNote: OPENAI_PRICING_NOTE, notes: { "claude-code": CLAUDE_PRICING_NOTE, codex: OPENAI_PRICING_NOTE } });
  }

  if (path === "/api/now") {
    return sendJson(res, 200, { now: Date.now(), ...radar.nowSnapshot() });
  }

  if (path === "/api/topics") {
    const windowMs = parseWindow(url.searchParams.get("window"));
    if (windowMs === undefined) return sendJson(res, 400, { error: "bad window (e.g. 24h, 90m, 7d)" });
    return sendJson(res, 200, { now: Date.now(), ...radar.topics(windowMs) });
  }

  if (path === "/api/settings") {
    return sendJson(res, 200, { now: Date.now(), summarizer: radar.summarizer?.status() ?? { enabled: false, reason: "kapalı", callsLastHour: 0, maxPerHour: 0 } });
  }

  if (path === "/api/sessions") {
    return sendJson(res, 200, snapshot(radar));
  }

  if (path === "/api/stream") {
    res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 2000\nevent: update\ndata: ${JSON.stringify({ ...snapshot(radar), changed: [] })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const m = /^\/api\/sessions\/([^/]+)(?:\/agents\/([^/]+)\/events)?$/.exec(path);
  if (m) {
    const sid = decodeURIComponent(m[1] ?? "");
    if (!radar.isSessionId(sid)) return sendJson(res, 400, { error: "bad session id" });
    if (m[2] === undefined) {
      const d = radar.getSession(sid);
      return d ? sendJson(res, 200, { now: Date.now(), session: d }) : sendJson(res, 404, { error: "unknown session" });
    }
    const agent = decodeURIComponent(m[2]);
    if (!AGENT_KEY.test(agent)) return sendJson(res, 400, { error: "bad agent id" });
    const opts: { tail?: number; after?: number; before?: number } = {};
    const tail = url.searchParams.get("tail");
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    if (after !== null) {
      const n = Number(after);
      if (!Number.isSafeInteger(n) || n < 0) return sendJson(res, 400, { error: "bad cursor" });
      opts.after = n;
    } else {
      if (tail !== null) {
        const n = Number(tail);
        if (!Number.isSafeInteger(n) || n < 1) return sendJson(res, 400, { error: "bad tail" });
        opts.tail = n;
      }
      if (before !== null) {
        const n = Number(before);
        if (!Number.isSafeInteger(n) || n < 0) return sendJson(res, 400, { error: "bad cursor" });
        opts.before = n;
      }
    }
    const r = await radar.readEvents(sid, agent, opts);
    return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: "unknown agent" });
  }

  return sendJson(res, 404, { error: "not found" });
}
