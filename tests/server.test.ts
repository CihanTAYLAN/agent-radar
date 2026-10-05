import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST, createRadarServer, hostAllowed, staticFile } from "../src/server.js";
import { Radar } from "../src/store.js";
import { S1, T_NOW, makeHome } from "./helpers.js";

let home: string;
let radar: Radar;
let server: Server;
let port: number;

beforeAll(async () => {
  let livePid: number;
  ({ home, livePid } = await makeHome());
  radar = new Radar({ claudeHome: home, watch: false, now: () => T_NOW, pidAlive: (p) => p === livePid, recentMs: 1e12 });
  await radar.scan(true);
  server = createRadarServer(radar);
  await new Promise<void>((res) => server.listen(0, HOST, res));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  radar.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
});

function get(path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("http api", () => {
  it("binds to loopback only", () => {
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("serves the UI with hardening headers", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("agent-radar");
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'self'");
    expect((await get("/app.js")).status).toBe(200);
    expect((await get("/style.css")).status).toBe(200);
  });

  it("serves topics and the summarizer status; rejects a bad window", async () => {
    const r = await get("/api/topics?window=24h");
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body) as { windowMs: number; topics: Array<{ id: string; title: string; summary: string; counts: { total: number }; agents: unknown[] }> };
    expect(j.windowMs).toBe(86_400_000);
    expect(Array.isArray(j.topics)).toBe(true);
    for (const t of j.topics) {
      expect(t.id).toMatch(/^[0-9a-f]{10}$/);
      expect(t.agents.length).toBeGreaterThan(0);
    }
    expect((await get("/api/topics?window=banana")).status).toBe(400);
    const st = JSON.parse((await get("/api/settings")).body) as { summarizer: { enabled: boolean } };
    expect(st.summarizer.enabled).toBe(false);
  });

  it("lists sessions", async () => {
    const r = await get("/api/sessions");
    const j = JSON.parse(r.body) as { sessions: Array<{ id: string; live: boolean; agentCount: number }> };
    expect(r.status).toBe(200);
    expect(j.sessions.find((s) => s.id === S1)).toMatchObject({ live: true, agentCount: 4 });
  });

  it("serves session detail with a nested tree", async () => {
    const j = JSON.parse((await get(`/api/sessions/${S1}`)).body) as { session: { tree: { children: unknown[] } } };
    expect(j.session.tree.children).toHaveLength(3);
  });

  it("serves events with tail and cursor", async () => {
    const a = JSON.parse((await get(`/api/sessions/${S1}/agents/a2/events?tail=10`)).body) as { events: unknown[]; cursor: number };
    expect(a.events).toHaveLength(3);
    const b = JSON.parse((await get(`/api/sessions/${S1}/agents/a2/events?after=${a.cursor}`)).body) as { events: unknown[] };
    expect(b.events).toEqual([]);
  });

  it("validates ids and cursors and never touches paths from the URL", async () => {
    expect((await get("/api/sessions/..%2F..%2Fetc/agents/x/events")).status).toBe(400);
    expect((await get(`/api/sessions/${S1}/agents/..%2Fx/events`)).status).toBe(400);
    expect((await get(`/api/sessions/${S1}/agents/a2/events?after=-5`)).status).toBe(400);
    expect((await get(`/api/sessions/${S1}/agents/a2/events?tail=abc`)).status).toBe(400);
    expect((await get("/api/sessions/cccccccc-0000-4000-8000-000000000003")).status).toBe(404);
    expect((await get("/../package.json")).status).toBe(404);
  });

  it("serves only flat, known-extension static files from public/", async () => {
    expect(staticFile("/timeline.js")).toEqual({ file: "timeline.js", type: "text/javascript; charset=utf-8" });
    expect(staticFile("/")?.file).toBe("index.html");
    for (const p of ["/../src/index.ts", "/a/b.js", "/x.json", "/.env", "/..js", "/%2e%2e.js", "/X.js"]) expect(staticFile(p), p).toBeUndefined();
    expect((await get("/missing-file.js")).status).toBe(404);
  });

  it("serves pricing estimates and machine counters", async () => {
    const p = JSON.parse((await get("/api/pricing")).body) as { estimates: Array<{ model: string; provider: string; output: number; verified: boolean }>; note: string };
    expect(p.estimates.find((e) => e.model === "claude-opus-5" && e.provider === "claude-code")).toMatchObject({ output: 25, verified: true });
    expect(p.note).toMatch(/Claude/);
    const s = JSON.parse((await get("/api/sessions")).body) as { machine: { liveSessions: number } };
    expect(s.machine.liveSessions).toBe(1);
  });

  it("serves the cross-session running list and today's finished agents", async () => {
    const r = await get("/api/now");
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body) as {
      running: Array<{ sessionId: string; agents: Array<{ key: string; state: string; lastAction?: { kind: string } }> }>;
      today: { done: number; failed: number; items: Array<{ key: string; sessionId: string }> };
      lastActivityAt: number;
    };
    const g = j.running.find((x) => x.sessionId === S1);
    expect(g?.agents.map((a) => a.key)).toEqual(["main", "a2"]);
    expect(g?.agents.every((a) => a.state === "running")).toBe(true);
    // a1, a3 (done) and w1 (stopped) finished on the fake clock's day.
    expect(j.today.done).toBe(3);
    expect(j.today.failed).toBe(0);
    expect(j.today.items.map((i) => i.key).sort()).toEqual(["a1", "a3", "w1"]);
    expect(j.lastActivityAt).toBeGreaterThan(0);
  });

  it("validates the before cursor", async () => {
    expect((await get(`/api/sessions/${S1}/agents/a2/events?before=-1`)).status).toBe(400);
    expect((await get(`/api/sessions/${S1}/agents/a2/events?tail=5&before=0`)).status).toBe(200);
  });

  it("is read-only: only GET/HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await get("/api/sessions", { method })).status).toBe(405);
    }
  });

  it("rejects foreign Host headers (DNS rebinding guard)", async () => {
    expect((await get("/api/sessions", { host: "evil.example" })).status).toBe(403);
    expect((await get("/api/sessions", { host: `localhost:${port}` })).status).toBe(200);
    expect(hostAllowed("127.0.0.1:4747")).toBe(true);
    expect(hostAllowed("[::1]:4747")).toBe(true);
    expect(hostAllowed("192.168.1.5:4747")).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("streams updates over SSE", async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const req = request({ host: HOST, port, path: "/api/stream", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.setEncoding("utf8");
        res.once("data", (c: string) => {
          resolve(c);
          req.destroy();
        });
      });
      req.on("error", (e) => {
        if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
      });
      req.end();
    });
    expect(first).toContain("event: update");
    expect(first).toContain(S1);
  });
});
