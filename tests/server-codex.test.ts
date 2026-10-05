import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST, createRadarServer } from "../src/server.js";
import { Radar } from "../src/store.js";
import { ClaudeCodeProvider } from "../src/providers/claude-code/provider.js";
import { CodexProvider } from "../src/providers/codex/provider.js";
import { S1, T_NOW, makeHome } from "./helpers.js";
import { AUTH_SENTINEL, C_NOW, CHILD, ROOT, SECRET, makeCodexHome } from "./codex-helpers.js";

let claudeHome: string;
let codexHome: string;
let radar: Radar;
let server: Server;
let port: number;

beforeAll(async () => {
  let livePid: number;
  ({ home: claudeHome, livePid } = await makeHome());
  ({ home: codexHome } = await makeCodexHome());
  radar = new Radar({
    providers: [
      new ClaudeCodeProvider({ claudeHome, watch: false, now: () => T_NOW, pidAlive: (p) => p === livePid, recentMs: 1e12 }),
      new CodexProvider({ codexHome, watch: false, now: () => C_NOW, recentMs: 24 * 3600_000 }),
    ],
  });
  await radar.scan(true);
  server = createRadarServer(radar);
  await new Promise<void>((res) => server.listen(0, HOST, res));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  radar.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(claudeHome, { recursive: true, force: true });
  await rm(codexHome, { recursive: true, force: true });
});

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("http api with several providers", () => {
  it("lists sessions of every provider with a provider field and namespaced ids", async () => {
    const j = JSON.parse((await get("/api/sessions")).body) as {
      sessions: Array<{ id: string; provider: string }>;
      machine: { liveSessions: number; byProvider: Record<string, { liveSessions: number }> };
      providers: Array<{ id: string }>;
    };
    expect(j.sessions.find((s) => s.id === S1)?.provider).toBe("claude-code");
    expect(j.sessions.find((s) => s.id === `codex:${ROOT}`)?.provider).toBe("codex");
    expect(j.machine.liveSessions).toBe(j.machine.byProvider["claude-code"]!.liveSessions + j.machine.byProvider["codex"]!.liveSessions);
    expect(j.machine.byProvider["codex"]!.liveSessions).toBe(1);
    expect(j.providers.map((p) => p.id)).toEqual(["claude-code", "codex"]);
  });

  it("routes namespaced ids to the provider and validates them", async () => {
    const d = JSON.parse((await get(`/api/sessions/${encodeURIComponent(`codex:${ROOT}`)}`)).body) as { session: { provider: string; tree: { children: Array<{ key: string }> } } };
    expect(d.session.provider).toBe("codex");
    expect(d.session.tree.children.map((c) => c.key)).toEqual([CHILD]);
    expect((await get(`/api/sessions/codex:${ROOT}`)).status).toBe(200);
    expect((await get(`/api/sessions/codex:not-a-uuid`)).status).toBe(400);
    expect((await get(`/api/sessions/nope:${ROOT}`)).status).toBe(400);
    expect((await get(`/api/sessions/codex:${ROOT.replace(/1$/, "9")}`)).status).toBe(404);
    // A Codex thread id without the prefix belongs to Claude Code's namespace: unknown there.
    expect((await get(`/api/sessions/${ROOT}`)).status).toBe(404);
    expect((await get(`/api/sessions/${S1}`)).status).toBe(200);
  });

  it("serves Codex events for main and subagents, masked", async () => {
    const r = await get(`/api/sessions/codex:${ROOT}/agents/main/events?tail=50`);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(SECRET);
    const c = JSON.parse((await get(`/api/sessions/codex:${ROOT}/agents/${CHILD}/events?tail=50`)).body) as { events: unknown[] };
    expect(c.events.length).toBeGreaterThan(0);
    expect((await get(`/api/sessions/codex:${ROOT}/agents/..%2Fauth/events`)).status).toBe(400);
  });

  it("serves provider health and never leaks deny-listed files", async () => {
    const j = JSON.parse((await get("/api/providers")).body) as { providers: Array<{ id: string; capabilities: Record<string, boolean>; notes: string[] }> };
    expect(j.providers.find((p) => p.id === "codex")?.capabilities["tokens"]).toBe(true);
    for (const path of ["/api/sessions", "/api/providers", `/api/sessions/codex:${ROOT}`, `/api/sessions/codex:${ROOT}/agents/main/events?tail=500`]) {
      expect((await get(path)).body, path).not.toContain(AUTH_SENTINEL);
    }
  });

  it("lists verified and unverified OpenAI prices next to the Claude prices", async () => {
    const p = JSON.parse((await get("/api/pricing")).body) as { estimates: Array<{ model: string; verified: boolean }>; estimatesNote: string };
    expect(p.estimates.some((e) => e.model === "claude-opus-5")).toBe(true);
    expect(p.estimates.length).toBeGreaterThan(3);
    expect(p.estimates.some((e) => e.verified === false)).toBe(true);
    expect(p.estimates.some((e) => e.verified === true)).toBe(true);
    expect(p.estimatesNote).toMatch(/doğrulanmadı/);
  });
});
