import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOST, createRadarServer } from "../src/server.js";
import { Radar } from "../src/store.js";
import { isDeniedPath, safeToRead } from "../src/providers/guard.js";
import { MAX_BYTES, GeminiCliProvider } from "../src/providers/gemini-cli/provider.js";
import { geminiCli } from "../src/providers/gemini-cli/index.js";
import { PROVIDERS } from "../src/providers/index.js";
import { contentText, describeCall, parseConversation, projectHashOf, resolveProjectRoot, toEvents, toUsage } from "../src/providers/gemini-cli/format.js";

// Synthetic fixtures that follow the schema read from gemini-cli v0.20.0 (chatRecordingService.ts).
// Nothing here is copied from real data.

const NOW = Date.parse("2026-03-10T10:10:00.000Z");
const SECRET = "sk-proj-THISISAFAKEKEYFORTESTS1234567890";
const SENTINEL = "GEMINI-AUTH-SENTINEL-DO-NOT-READ";
const ROOT_DONE = "/tmp/gm-demo/proj";
const ROOT_LIVE = "/tmp/gm-demo/live";
const ROOT_PENDING = "/tmp/gm-demo/pending";
const ROOT_IDLE = "/tmp/gm-demo/idle";
const ID_DONE = "11111111-aaaa-4000-8000-000000000001";
const ID_LIVE = "22222222-aaaa-4000-8000-000000000002";
const ID_PENDING = "33333333-aaaa-4000-8000-000000000003";
const ID_IDLE = "44444444-aaaa-4000-8000-000000000004";

const iso = (ms: number) => new Date(ms).toISOString();

type Rec = Record<string, unknown>;
const user = (ms: number, text: string): Rec => ({ id: `u${ms}`, timestamp: iso(ms), type: "user", content: [{ text }] });
const gem = (ms: number, content: string, extra: Rec = {}): Rec => ({ id: `g${ms}`, timestamp: iso(ms), type: "gemini", content, ...extra });
const tokens = (input: number, output: number, cached: number, thoughts = 0, tool = 0) => ({ input, output, cached, thoughts, tool, total: input + output + thoughts + tool });
const call = (ms: number, id: string, name: string, args: Rec, status: string, resultDisplay?: string): Rec => ({
  id,
  name,
  args,
  status,
  timestamp: iso(ms),
  displayName: name,
  description: "",
  renderOutputAsMarkdown: false,
  ...(resultDisplay !== undefined ? { resultDisplay, result: [{ functionResponse: { id, name, response: { output: resultDisplay } } }] } : {}),
});

function conv(sessionId: string, root: string, messages: Rec[]): Rec {
  const first = Date.parse(String(messages[0]?.["timestamp"]));
  const last = Date.parse(String(messages[messages.length - 1]?.["timestamp"]));
  return { sessionId, projectHash: projectHashOf(root), startTime: iso(first), lastUpdated: iso(last), messages };
}

const T0 = NOW - 30 * 60_000;
const DONE_MSGS = (): Rec[] => [
  user(T0, "Run the tests and fix the failing one"),
  gem(T0 + 5_000, "", {
    model: "gemini-2.5-pro",
    thoughts: [{ subject: "Planning", description: "Run the suite first", timestamp: iso(T0 + 4_000) }],
    tokens: tokens(1000, 50, 200, 30, 5),
    toolCalls: [call(T0 + 6_000, "call-1", "run_shell_command", { command: `cd ${ROOT_DONE} && npm test -- --token=${SECRET}`, description: "Run tests" }, "success", "1 failing")],
  }),
  gem(T0 + 20_000, "", {
    model: "gemini-2.5-pro",
    tokens: tokens(1500, 80, 400),
    toolCalls: [
      call(T0 + 21_000, "call-2", "read_file", { absolute_path: `${ROOT_DONE}/src/a.ts` }, "success", "export const a = 1;"),
      call(T0 + 22_000, "call-3", "replace", { file_path: `${ROOT_DONE}/src/a.ts`, old_string: "1", new_string: "2" }, "error", "no match"),
    ],
  }),
  gem(T0 + 40_000, "Fixed it. The suite is green now.", { model: "gemini-2.5-flash", tokens: tokens(2000, 120, 0, 10) }),
  { id: "i1", timestamp: iso(T0 + 41_000), type: "info", content: "Request cancelled." },
];

interface Home {
  home: string;
  gemini: string;
  bin: string;
}

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function put(gemini: string, hash: string, name: string, body: unknown, mtimeMs: number): Promise<string> {
  const dir = join(gemini, "tmp", hash, "chats");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

async function makeHome(opts: { empty?: boolean } = {}): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), "radar-gemini-"));
  homes.push(home);
  const gemini = join(home, ".gemini");
  await mkdir(gemini, { recursive: true });
  const bin = join(home, "gemini-bin");
  await writeFile(bin, "#!/bin/sh\n");
  // Things that belong to other tools / hold credentials: must never be read.
  await writeFile(join(gemini, "oauth_creds.json"), JSON.stringify({ refresh_token: SENTINEL }));
  await writeFile(join(gemini, "google_accounts.json"), JSON.stringify({ active: SENTINEL }));
  await writeFile(join(gemini, "settings.json"), JSON.stringify({ apiKey: SENTINEL }));
  await writeFile(join(gemini, ".env"), `GEMINI_API_KEY=${SENTINEL}\n`);
  await mkdir(join(gemini, "antigravity"), { recursive: true });
  await writeFile(join(gemini, "antigravity", "session-x.json"), JSON.stringify({ sessionId: "zzzz", messages: [{ type: "user", content: SENTINEL }] }));
  if (opts.empty) return { home, gemini, bin };
  await put(gemini, projectHashOf(ROOT_DONE), "session-2026-03-10T10-01-11111111.json", conv(ID_DONE, ROOT_DONE, DONE_MSGS()), NOW - 20 * 60_000);
  // live: last message from the user, changed 20 s ago
  await put(
    gemini,
    projectHashOf(ROOT_LIVE),
    "session-2026-03-10T10-09-22222222.json",
    conv(ID_LIVE, ROOT_LIVE, [user(NOW - 60_000, "start"), gem(NOW - 40_000, "ok", { model: "gemini-2.5-pro", tokens: tokens(10, 5, 0) }), user(NOW - 20_000, "now add a test")]),
    NOW - 20_000,
  );
  // live: pending tool call
  await put(
    gemini,
    projectHashOf(ROOT_PENDING),
    "session-2026-03-10T10-09-33333333.json",
    conv(ID_PENDING, ROOT_PENDING, [
      user(NOW - 50_000, "build it"),
      gem(NOW - 30_000, "", {
        model: "gemini-2.5-pro",
        toolCalls: [
          call(NOW - 31_000, "p1", "read_file", { absolute_path: `${ROOT_PENDING}/x.ts` }, "success", "x"),
          call(NOW - 30_000, "p2", "run_shell_command", { command: "npm run build", dir_path: ROOT_PENDING }, "executing"),
        ],
      }),
    ]),
    NOW - 30_000,
  );
  // idle: answered, changed 5 min ago
  await put(
    gemini,
    projectHashOf(ROOT_IDLE),
    "session-2026-03-10T10-05-44444444.json",
    conv(ID_IDLE, ROOT_IDLE, [user(NOW - 320_000, "hi"), gem(NOW - 300_000, "hello", { model: "gemini-2.5-flash", tokens: tokens(5, 5, 0) })]),
    NOW - 300_000,
  );
  return { home, gemini, bin };
}

function provider(h: Home, over: Partial<ConstructorParameters<typeof GeminiCliProvider>[0]> = {}): GeminiCliProvider {
  return new GeminiCliProvider({ geminiHome: h.gemini, watch: false, now: () => NOW, userHome: "/nonexistent-home", binPaths: [h.bin], ...over });
}

describe("gemini-cli format", () => {
  it("hashes the project root like storage.ts and resolves it from tool-call paths only when it matches", () => {
    const hash = projectHashOf(ROOT_DONE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveProjectRoot(hash, [`${ROOT_DONE}/src/deep/a.ts`])).toBe(ROOT_DONE);
    expect(resolveProjectRoot(hash, ["/somewhere/else/a.ts"])).toBeUndefined();
  });

  it("reads every PartListUnion shape", () => {
    expect(contentText("plain")).toBe("plain");
    expect(contentText({ text: "one" })).toBe("one");
    expect(contentText([{ text: "a" }, { text: "b" }])).toBe("a\nb");
    expect(contentText([{ functionResponse: { id: "1", name: "x", response: { output: "out" } } }])).toBe("out");
    expect(contentText(undefined)).toBe("");
  });

  it("maps token summaries: cached is split out, thoughts count as output", () => {
    expect(toUsage({ input: 1000, output: 50, cached: 200, thoughts: 30, tool: 5, total: 1085 })).toEqual({ input: 805, output: 80, cacheRead: 200, cacheCreate: 0 });
  });

  it("humanizes tool calls", () => {
    expect(describeCall("run_shell_command", { command: "cd /x && ls -la", dir_path: "/y" })).toMatchObject({ action: { kind: "bash", target: "ls -la", dir: "/x" } });
    expect(describeCall("replace", { file_path: "/a/b/c/d/e.ts" }).action).toMatchObject({ kind: "edit", target: "…/c/d/e.ts" });
    expect(describeCall("write_file", { file_path: "/a.ts" }).action.kind).toBe("write");
    expect(describeCall("read_file", { absolute_path: "/a.ts" }).action.kind).toBe("read");
    expect(describeCall("glob", { pattern: "**/*.ts" }).action).toMatchObject({ kind: "search", target: "**/*.ts" });
    expect(describeCall("search_file_content", { pattern: "foo" }).action.kind).toBe("search");
    expect(describeCall("google_web_search", { query: "q" }).action.kind).toBe("web");
    expect(describeCall("mystery", {}).action.kind).toBe("other");
  });

  it("survives garbage", () => {
    expect(parseConversation("{ not json")).toBeUndefined();
    expect(parseConversation('{"messages": 3}')).toBeUndefined();
    const c = parseConversation(JSON.stringify({ messages: [null, 5, { type: "weird" }, { type: "user", content: "hi" }, { type: "gemini", toolCalls: [null, { name: "x" }], tokens: "no" }] }));
    expect(c?.messages.map((m) => m.type)).toEqual(["user", "gemini"]);
    expect(toEvents(c!).length).toBeGreaterThan(0);
  });

  it("flattens messages into masked events with call/result pairs", () => {
    const c = parseConversation(JSON.stringify(conv(ID_DONE, ROOT_DONE, DONE_MSGS())))!;
    const ev = toEvents(c);
    expect(ev.map((e) => e.kind)).toEqual(["user", "thinking", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "assistant", "notification"]);
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(ev.find((e) => e.toolUseId === "call-3" && e.kind === "tool_result")?.isError).toBe(true);
    expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
  });
});

describe("gemini-cli provider", () => {
  it("is registered and marked GE", () => {
    expect(PROVIDERS.some((f) => f.id === "gemini-cli")).toBe(true);
    expect(geminiCli.label).toBe("Gemini CLI");
  });

  it("lists sessions with tokens, model, tools and a verified cwd", async () => {
    const h = await makeHome();
    const p = provider(h);
    await p.scan(true);
    const s = p.listSessions().find((x) => x.id === `gemini-cli:${ID_DONE}`)!;
    expect(s.provider).toBe("gemini-cli");
    expect(s.live).toBe(false);
    expect(s.cwd).toBe(ROOT_DONE);
    expect(s.name).toBe("Run the tests and fix the failing one");
    expect(s.model).toBe("gemini-2.5-flash");
    expect(s.costUsd).toBe(0);
    // input: (1000-200+5) + (1500-400) + 2000 ; output: (50+30) + 80 + (120+10) ; cacheRead 600
    expect(s.usage).toEqual({ input: 805 + 1100 + 2000, output: 80 + 80 + 130, cacheRead: 600, cacheCreate: 0 });
    const d = p.getSession(ID_DONE)!;
    expect(d.tree.toolCalls).toBe(3);
    expect(d.tree.messages).toBe(5);
    expect(d.tree.children).toEqual([]);
    expect(d.tree.state).toBe("done");
    expect(Object.keys(d.usageByModel).sort()).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(d.costByModel["gemini-2.5-pro"]).toBeNull();
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(p.getSession("nope")).toBeUndefined();
  });

  it("shows the shortened hash when the project root cannot be recovered", async () => {
    const h = await makeHome({ empty: true });
    const hash = projectHashOf("/nowhere/known");
    await put(h.gemini, hash, "session-2026-03-10T10-01-55555555.json", conv("55555555-aaaa-4000-8000-000000000005", "/nowhere/known", [user(NOW - 60_000, "hi")]), NOW - 60_000);
    const p = provider(h);
    await p.scan(true);
    expect(p.listSessions()[0]?.cwd).toBe(`proje#${hash.slice(0, 8)}`);
  });

  it("distinguishes live (user turn / pending tool), idle and done", async () => {
    const h = await makeHome();
    const p = provider(h);
    await p.scan(true);
    const by = (id: string) => p.getSession(id)!;
    expect(by(ID_LIVE).live).toBe(true);
    expect(by(ID_LIVE).tree.state).toBe("running");
    expect(by(ID_LIVE).status).toBe("busy");
    expect(by(ID_PENDING).tree.state).toBe("running");
    expect(by(ID_PENDING).tree.lastAction).toMatchObject({ kind: "bash", target: "npm run build" });
    expect(by(ID_PENDING).tree.lastTool).toBe("run_shell_command");
    expect(by(ID_IDLE).tree.state).toBe("idle");
    expect(by(ID_IDLE).live).toBe(true);
    expect(by(ID_IDLE).tree.lastAction).toBeUndefined();
    expect(by(ID_DONE).tree.state).toBe("done");
    expect(by(ID_DONE).live).toBe(false);
    expect(p.machine().liveSessions).toBe(3);
    expect(p.machine().runningAgents).toBe(2);
  });

  it("turns a running session into idle then done as the file ages", async () => {
    const h = await makeHome();
    let now = NOW;
    const p = provider(h, { now: () => now });
    await p.scan(true);
    expect(p.getSession(ID_LIVE)!.tree.state).toBe("running");
    now = NOW + 3 * 60_000; // > 2 min without a change: no longer running, still idle
    expect(p.getSession(ID_LIVE)!.tree.state).toBe("idle");
    now = NOW + 11 * 60_000;
    expect(p.getSession(ID_LIVE)!.tree.state).toBe("done");
  });

  it("re-reads a session file that was rewritten (mtime change) and emits a change", async () => {
    const h = await makeHome();
    const p = provider(h);
    await p.scan(true);
    const seen: string[][] = [];
    p.onChange((ids) => seen.push(ids));
    const msgs = [user(NOW - 60_000, "start"), gem(NOW - 40_000, "ok", { model: "gemini-2.5-pro", tokens: tokens(10, 5, 0) }), user(NOW - 20_000, "now add a test"), gem(NOW - 5_000, "done", { model: "gemini-2.5-pro", tokens: tokens(20, 7, 0) })];
    await put(h.gemini, projectHashOf(ROOT_LIVE), "session-2026-03-10T10-09-22222222.json", conv(ID_LIVE, ROOT_LIVE, msgs), NOW - 5_000);
    await p.scan(false);
    expect(p.getSession(ID_LIVE)!.tree.messages).toBe(4);
    expect(p.getSession(ID_LIVE)!.tree.state).toBe("idle");
    expect(p.getSession(ID_LIVE)!.usage.output).toBe(12);
    expect(seen.flat()).toContain(`gemini-cli:${ID_LIVE}`);
  });

  it("keeps the old data when a rewrite is caught half-written", async () => {
    const h = await makeHome();
    const p = provider(h);
    await p.scan(true);
    await put(h.gemini, projectHashOf(ROOT_LIVE), "session-2026-03-10T10-09-22222222.json", '{"sessionId": "22222222-aaaa-4000-8000-000000000002", "messages": [', NOW - 1_000);
    await p.scan(false);
    expect(p.getSession(ID_LIVE)!.tree.messages).toBe(3);
  });

  it("skips oversized session files and says so in the status", async () => {
    const h = await makeHome({ empty: true });
    const file = await put(h.gemini, projectHashOf("/big"), "session-2026-03-10T10-01-66666666.json", "{}", NOW - 1_000);
    await truncate(file, MAX_BYTES + 1); // sparse: cheap
    await utimes(file, new Date(NOW - 1_000), new Date(NOW - 1_000));
    const p = provider(h);
    await p.scan(true);
    expect(p.listSessions()).toEqual([]);
    expect(p.status().notes.join(" ")).toMatch(/50 MB üstü/);
  });

  it("ignores old files outside the recent window and non-session files", async () => {
    const h = await makeHome({ empty: true });
    const hash = projectHashOf(ROOT_DONE);
    await put(h.gemini, hash, "session-2026-03-01T10-01-11111111.json", conv(ID_DONE, ROOT_DONE, DONE_MSGS()), NOW - 3 * 24 * 3600_000);
    await put(h.gemini, hash, "settings.json", { sessionId: "77777777", messages: [{ type: "user", content: SENTINEL }] }, NOW - 1_000);
    await put(h.gemini, hash, "logs.json", [{ sessionId: "88888888", message: SENTINEL }], NOW - 1_000);
    const p = provider(h);
    await p.scan(true);
    expect(p.listSessions()).toEqual([]);
    expect(p.status().dataFound).toBe(true); // a session file exists, just not recent
  });

  it("pages events by index and supports the after cursor", async () => {
    const h = await makeHome();
    const p = provider(h);
    await p.scan(true);
    const all = (await p.readEvents(ID_DONE, "main", { tail: 500 }))!;
    expect(all.events).toHaveLength(10);
    expect(all.truncated).toBe(false);
    expect(all.reset).toBe(false);
    expect(JSON.stringify(all)).not.toContain(SECRET);
    const tail = (await p.readEvents(ID_DONE, "main", { tail: 3 }))!;
    expect(tail.events.map((e) => e.id)).toEqual(all.events.slice(-3).map((e) => e.id));
    expect(tail.truncated).toBe(true);
    expect(tail.start).toBe(7);
    const older = (await p.readEvents(ID_DONE, "main", { tail: 3, before: tail.start }))!;
    expect(older.events.map((e) => e.id)).toEqual(all.events.slice(4, 7).map((e) => e.id));
    const after = (await p.readEvents(ID_DONE, "main", { after: all.cursor }))!;
    expect(after.events).toEqual([]);
    const some = (await p.readEvents(ID_DONE, "main", { after: 8 }))!;
    expect(some.events).toHaveLength(2);
    const stale = (await p.readEvents(ID_DONE, "main", { after: 9999 }))!;
    expect(stale.reset).toBe(true);
    expect(await p.readEvents(ID_DONE, "child-1", { tail: 5 })).toBeUndefined();
    expect(await p.readEvents("nope", "main", {})).toBeUndefined();
  });

  it("reports installed / dataFound / capabilities / notes honestly", async () => {
    const h = await makeHome({ empty: true });
    const p = provider(h);
    await p.scan(true);
    const st = p.status();
    expect(st).toMatchObject({ id: "gemini-cli", label: "Gemini CLI", mark: "GE", installed: true, dataFound: false, sessions: 0, active: 0 });
    expect(st.capabilities).toEqual({ transcript: true, tokens: true, tools: true, subagents: false, cost: false });
    expect(st.notes).toContain("format kaynak koddan türetildi; bu makinede gerçek veriyle doğrulanmadı");
    expect(st.notes.join(" ")).toContain("`gemini` bir kez çalıştırılınca oturumlar görünür");
    expect(provider(h, { binPaths: [join(h.home, "missing")] }).status().installed).toBe(false);

    const h2 = await makeHome();
    const p2 = provider(h2);
    await p2.scan(true);
    expect(p2.status()).toMatchObject({ dataFound: true, sessions: 4, active: 3 });
    expect(p2.status().notes.join(" ")).not.toContain("bir kez çalıştırılınca");
  });

  it("never reads anything outside ~/.gemini/tmp (deny-list and guard roots)", async () => {
    const h = await makeHome();
    const roots = [join(h.gemini, "tmp")];
    for (const f of ["oauth_creds.json", "google_accounts.json", "settings.json", ".env", "installation_id", "antigravity/session-x.json", "jetski-standalone-oauth-token", "config"]) {
      expect(safeToRead(join(h.gemini, f), roots), f).toBe(false);
    }
    expect(safeToRead(join(h.gemini, "tmp", "..", "oauth_creds.json"), roots)).toBe(false);
    expect(safeToRead(join(h.gemini, "tmp", "abc", "chats", "session-1.json"), roots)).toBe(true);
    expect(isDeniedPath(join(h.gemini, "oauth_creds.json"))).toBe(true);
    expect(isDeniedPath(join(h.gemini, "jetski-standalone-oauth-token"))).toBe(true);
    expect(isDeniedPath(join(h.gemini, ".env"))).toBe(true);

    const p = provider(h);
    await p.scan(true);
    const out = JSON.stringify([p.listSessions(), p.status(), ...p.listSessions().map((s) => p.getSession(s.id.replace("gemini-cli:", "")))]);
    expect(out).not.toContain(SENTINEL);
  });
});

describe("gemini-cli through the http api", () => {
  let h: Home;
  let radar: Radar;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    h = await makeHome();
    radar = new Radar({ providers: [provider(h)] });
    await radar.scan(true);
    server = createRadarServer(radar);
    await new Promise<void>((res) => server.listen(0, HOST, res));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    radar.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(h.home, { recursive: true, force: true });
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

  it("serves sessions, detail and events under the gemini-cli: namespace", async () => {
    const list = JSON.parse((await get("/api/sessions")).body) as { sessions: Array<{ id: string; provider: string }> };
    expect(list.sessions.find((s) => s.id === `gemini-cli:${ID_DONE}`)?.provider).toBe("gemini-cli");
    const d = JSON.parse((await get(`/api/sessions/${encodeURIComponent(`gemini-cli:${ID_PENDING}`)}`)).body) as { session: { tree: { lastAction: { kind: string } } } };
    expect(d.session.tree.lastAction.kind).toBe("bash");
    const ev = await get(`/api/sessions/gemini-cli:${ID_DONE}/agents/main/events?tail=50`);
    expect(ev.status).toBe(200);
    expect(ev.body).not.toContain(SECRET);
    expect(JSON.parse(ev.body).events.length).toBe(10);
    expect((await get(`/api/sessions/gemini-cli:${ID_DONE.replace(/1$/, "9")}`)).status).toBe(404);
    expect((await get("/api/sessions/gemini-cli:..%2Fauth")).status).toBe(400);
  });

  it("serves provider health without leaking credentials", async () => {
    const j = JSON.parse((await get("/api/providers")).body) as { providers: Array<{ id: string; mark: string; capabilities: Record<string, boolean>; installed: boolean }> };
    const g = j.providers.find((x) => x.id === "gemini-cli")!;
    expect(g.mark).toBe("GE");
    expect(g.capabilities["subagents"]).toBe(false);
    for (const path of ["/api/sessions", "/api/providers", `/api/sessions/gemini-cli:${ID_DONE}`, `/api/sessions/gemini-cli:${ID_DONE}/agents/main/events?tail=500`]) {
      expect((await get(path)).body, path).not.toContain(SENTINEL);
    }
  });
});
