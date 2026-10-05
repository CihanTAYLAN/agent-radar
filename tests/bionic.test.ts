import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDeniedPath, safeToRead } from "../src/providers/guard.js";
import { allowedBionicFile } from "../src/providers/bionic/format.js";
import { BionicProvider } from "../src/providers/bionic/provider.js";
import { bionic } from "../src/providers/bionic/index.js";
import { PROVIDERS } from "../src/providers/index.js";

/**
 * Synthetic Bionic home: two projects with a WAL-mode ng-sessions.sqlite each, built with node:sqlite in
 * a temp dir. Every value here is made up; nothing is copied from real data.
 */
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3600_000;
const SECRET = "sk-proj-THISISAFAKEKEYFORTESTS1234567890";
const SENTINEL = "SETTINGS-SENTINEL-DO-NOT-READ";

const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const P2 = "aaaaaaaa-0000-4000-8000-000000000002";
const sid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RUN = sid(1);
const KID = sid(2);
const IDLE = sid(3);
const OLDROOT = sid(4);
const ANCIENT = sid(5);
const TRANS_DONE = sid(6);
const TEMP = sid(7);
const ERR = sid(8);
const TRANS_LIVE = sid(9);
const REVIEWER = sid(10);

type E = Record<string, unknown>;
let seq = 0;
const txt = (t: string) => ({ type: "text", text: t });
const user = (t: string, ts: number, extra: E = {}): E => ({ type: "message", message: { role: "user", parts: [txt(t)] }, createdTimestamp: ts, ...extra });
const asst = (parts: unknown[], ts: number, total = 4200): E => ({ type: "message", message: { role: "assistant", parts }, createdTimestamp: ts, context: { before: 100, self: 50, total } });
const call = (id: string, name: string, parameters: E) => ({ type: "toolCallRequest", uniqueToolCallId: id, modelToolCallId: `m-${id}`, name, resolvedToolId: `ngModule:x:${name}`, parameters });
const result = (id: string, text: string, ts: number): E => ({ type: "message", message: { role: "tool", parts: [{ type: "toolCallResult", uniqueToolCallId: id, modelToolCallId: `m-${id}`, result: [txt(text)] }] }, createdTimestamp: ts });
const summary = (ms: number): E => ({ type: "turnSummary", durationMs: ms, files: [{ filePath: "/x/a.ts" }] });
const state = (): E => ({ type: "stateChange", stateChanges: [{ key: "env", previewText: "cwd", value: { cwd: "/x" } }] });
const subref = (sessionId: string, workingTitle: string, doneTitle?: string): E => ({ type: "subSessionReference", sessionId, workingTitle, ...(doneTitle ? { doneTitle } : {}) });

let home: string;
let projectsDir: string;
let writers: DatabaseSync[] = [];
let dbFile1: string;

function makeDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, ".internal", "ng-sessions.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(`CREATE TABLE chat_entries (id TEXT PRIMARY KEY, previous_id TEXT, entry_json TEXT NOT NULL);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, session_name TEXT, committed_head_entry_id TEXT, session_json TEXT NOT NULL,
      updated_timestamp INTEGER NOT NULL, user_draft_json TEXT, is_transient INTEGER NOT NULL DEFAULT 0, suggested_session_name TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0, is_temporary INTEGER NOT NULL DEFAULT 0, parent_session_id TEXT, companion_session_as TEXT);`);
  return db;
}

interface S {
  id: string;
  entries: E[];
  updated: number;
  name?: string;
  suggested?: string;
  transient?: boolean;
  temporary?: boolean;
  parent?: string;
  companion?: string;
  model?: string;
  cwd?: string;
  noHead?: boolean;
}

function put(db: DatabaseSync, s: S): void {
  let prev: string | null = null;
  let head: string | null = null;
  for (const e of s.entries) {
    const id = `e${++seq}`;
    db.prepare("INSERT INTO chat_entries (id, previous_id, entry_json) VALUES (?, ?, ?)").run(id, prev, JSON.stringify({ id, previousId: prev, ...e }));
    prev = id;
    head = id;
  }
  const cfg = {
    baseSystemPrompt: "x".repeat(50),
    modelSpecifier: { type: "model", model: s.model ?? "qwen3-coder-30b" },
    inferenceConfig: { reasoningLevel: "medium" },
    sessionConfig: { shellMode: "auto" },
    sessionParams: { working_directory: s.cwd ?? "/work/demo" },
    contextEstimation: { before: 10, self: 20, total: 1234 },
    queuedUserTurns: [],
  };
  db.prepare(
    "INSERT INTO sessions (session_id, session_name, committed_head_entry_id, session_json, updated_timestamp, is_transient, suggested_session_name, is_temporary, parent_session_id, companion_session_as) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(s.id, s.name ?? null, s.noHead ? null : head, JSON.stringify(cfg), s.updated, s.transient ? 1 : 0, s.suggested ?? null, s.temporary ? 1 : 0, s.parent ?? null, s.companion ?? null);
}

const sha = async (f: string) => createHash("sha256").update(await readFile(f)).digest("hex");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bionic-test-"));
  projectsDir = join(home, "projects");
  for (const p of [P1, P2]) await mkdir(join(projectsDir, p, ".internal"), { recursive: true });
  await writeFile(join(projectsDir, P1, "project.json"), JSON.stringify({ name: "demo-app", projectType: "regular" }));
  await writeFile(join(projectsDir, P2, "project.json"), JSON.stringify({ name: "Orchestration", projectType: "regular" }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ hfToken: SENTINEL }));
  await writeFile(join(home, "hf-token.json"), SENTINEL);

  const d1 = makeDb(join(projectsDir, P1));
  const d2 = makeDb(join(projectsDir, P2));
  writers = [d1, d2];
  dbFile1 = join(projectsDir, P1, ".internal", "ng-sessions.sqlite");

  // RUN: open turn (pending sub-agent tool call) updated 30 s ago; one finished sub-session.
  put(d1, {
    id: RUN,
    suggested: "Fix the login bug",
    updated: NOW - 30_000,
    model: "qwen3-coder-30b",
    cwd: "/work/demo",
    entries: [
      state(),
      user(`please run the tests, key ${SECRET}`, NOW - 10 * MIN),
      asst([{ type: "reasoning", text: "thinking about tests" }, txt("Running them now."), call("c1", "shell_command", { command: `cd /work/demo && API_KEY=${SECRET} npm test`, timeout_ms: 60000 })], NOW - 9 * MIN),
      result("c1", "12 passed", NOW - 8 * MIN),
      asst([call("c2", "read_file_lines", { path: "/work/demo/src/a.ts", start_line: 1, lines_to_read: 20 })], NOW - 7 * MIN),
      result("c2", "line one", NOW - 6 * MIN),
      subref(KID, "Exploring", "Explored the repo"),
      summary(1000),
      user("now dig deeper", NOW - 2 * MIN),
      asst([call("c3", "agentic_find", { queries: ["where is auth"] })], NOW - 30_000, 5300),
    ],
  });
  put(d1, {
    id: KID,
    name: "explorer",
    transient: true,
    parent: RUN,
    updated: NOW - 8 * HOUR,
    entries: [user("find things", NOW - 8 * HOUR - MIN), asst([call("k1", "find_files", { path: "/work/demo", glob: "*.ts" })], NOW - 8 * HOUR - 30_000), result("k1", "a.ts", NOW - 8 * HOUR - 20_000), asst([txt("done")], NOW - 8 * HOUR), summary(60000)],
  });
  put(d1, {
    id: REVIEWER,
    name: "reviewer",
    transient: true,
    parent: RUN,
    companion: "ngModule:lmstudio:shell-v1:approvalReviewer",
    updated: NOW - 9 * HOUR,
    entries: [user("review this", NOW - 9 * HOUR), asst([txt("ok")], NOW - 9 * HOUR + 1000), summary(500)],
  });
  // IDLE: finished answer 5 min ago.
  put(d1, { id: IDLE, name: "Idle chat", updated: NOW - 5 * MIN, entries: [user("hello", NOW - 6 * MIN), asst([txt("hi there")], NOW - 5 * MIN), summary(2000)] });
  // OLDROOT: 3 h ago, done. ANCIENT: 100 h ago (outside the recent window).
  put(d1, { id: OLDROOT, suggested: "Old work", updated: NOW - 3 * HOUR, entries: [user("old", NOW - 3 * HOUR), asst([txt("ok")], NOW - 3 * HOUR + 1000), summary(500)] });
  put(d1, { id: ANCIENT, suggested: "Ancient", updated: NOW - 100 * HOUR, entries: [user("ancient", NOW - 100 * HOUR), asst([txt("ok")], NOW - 100 * HOUR + 1000)] });
  // Transient orphan roots and a temporary session without entries.
  put(d1, { id: TRANS_DONE, name: "hidden transient", transient: true, updated: NOW - 2 * HOUR, entries: [user("t", NOW - 2 * HOUR), asst([txt("ok")], NOW - 2 * HOUR + 1000), summary(10)] });
  put(d1, { id: TRANS_LIVE, name: "live transient", transient: true, updated: NOW - 20_000, entries: [user("go", NOW - 20_000)] });
  put(d1, { id: TEMP, temporary: true, noHead: true, updated: NOW - MIN, entries: [] });
  // ERR (project 2): ends with an error entry.
  put(d2, { id: ERR, suggested: "Broken run", updated: NOW - 3 * HOUR, entries: [user("try", NOW - 3 * HOUR), asst([call("e1", "web_search", { objective: "x", searchQueries: ["a"] })], NOW - 3 * HOUR + 1000), { type: "error", message: "boom", critical: true, errorCode: "quota" }] });
});

afterAll(async () => {
  for (const w of writers) w.close();
  await rm(home, { recursive: true, force: true });
});

const make = (now = NOW, extra: Partial<ConstructorParameters<typeof BionicProvider>[0]> = {}) =>
  new BionicProvider({ bionicHome: home, now: () => now, recentMs: 24 * HOUR, userHome: "/Users/none", ...extra });

async function scanned(now = NOW): Promise<BionicProvider> {
  const p = make(now);
  await p.scan(true);
  return p;
}

describe("bionic: discovery and mapping", () => {
  it("lists roots with global ids; sub-sessions, transient and temporary ones are not listed", async () => {
    const p = await scanned();
    const ids = p.listSessions().map((s) => s.id).sort();
    expect(ids).toEqual([`bionic:${RUN}`, `bionic:${IDLE}`, `bionic:${OLDROOT}`, `bionic:${ERR}`, `bionic:${TRANS_LIVE}`].sort());
    expect(p.loading).toBe(false);
    expect(PROVIDERS.map((f) => f.id)).toContain("bionic");
    expect(bionic.label).toBe("Bionic");
  });

  it("maps name, cwd, model, project, context estimate (not usage), no tokens or cost", async () => {
    const p = await scanned();
    const s = p.listSessions().find((x) => x.id === `bionic:${RUN}`);
    expect(s).toBeDefined();
    expect(s?.name).toBe("Fix the login bug");
    expect(s?.cwd).toBe("/work/demo");
    expect(s?.model).toBe("qwen3-coder-30b");
    expect(s?.entrypoint).toBe("demo-app · bağlam ~5,3k token");
    expect(s?.totalTokens).toBe(0);
    expect(s?.costUsd).toBe(0);
    expect(s?.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    expect(s?.lastPrompt).toContain("now dig deeper");
    expect(s?.agentCount).toBe(2);
    expect(s?.hasTranscript).toBe(true);
    const err = p.listSessions().find((x) => x.id === `bionic:${ERR}`);
    expect(err?.entrypoint).toBe("Orchestration · bağlam ~4,2k token");
    expect(err?.name).toBe("Broken run");
  });

  it("nests sub-sessions in the agent tree with their labels and types", async () => {
    const p = await scanned();
    const d = p.getSession(RUN);
    expect(d?.tree.key).toBe("main");
    expect(d?.tree.children.map((c) => c.key).sort()).toEqual([KID, REVIEWER].sort());
    const kid = d?.tree.children.find((c) => c.key === KID);
    expect(kid).toMatchObject({ label: "explorer", agentType: "alt oturum", parentKey: "main", state: "done", messages: 3, toolCalls: 1 });
    expect(d?.tree.children.find((c) => c.key === REVIEWER)?.agentType).toBe("onay denetçisi");
    expect(d?.tree.toolCalls).toBe(3);
    expect(d?.usageByModel).toEqual({});
    expect(p.getSession(KID)).toBeUndefined();
    expect(p.getSession("not-a-session")).toBeUndefined();
  });

  it("status reports capabilities, mark, notes and last activity", async () => {
    const p = await scanned();
    const st = p.status();
    expect(st).toMatchObject({ id: "bionic", label: "Bionic", mark: "BI", installed: true, dataFound: true, sessions: 5 });
    expect(st.capabilities).toEqual({ transcript: true, tokens: false, tools: true, subagents: true, cost: false });
    expect(st.notes.join("\n")).toContain("yerel model; token/maliyet tutulmuyor");
    expect(st.lastActivityAt).toBe(NOW - 20_000);
  });

  it("keeps reporting installed / dataFound / last activity when the data is old", async () => {
    const p = make(NOW + 1000 * HOUR, { recentMs: HOUR });
    await p.scan(true);
    const st = p.status();
    expect(p.listSessions()).toEqual([]);
    expect(st).toMatchObject({ installed: true, dataFound: true, sessions: 0, active: 0 });
    expect(st.lastActivityAt).toBe(NOW - 20_000);
  });

  it("reports not installed for a missing home", async () => {
    const p = new BionicProvider({ bionicHome: join(home, "nope"), now: () => NOW });
    await p.scan(true);
    expect(p.status()).toMatchObject({ installed: false, dataFound: false, sessions: 0 });
    expect(p.status().lastActivityAt).toBeUndefined();
  });
});

describe("bionic: live heuristic", () => {
  it("running: updated within 2 min and the newest entry is an open tool call", async () => {
    const p = await scanned();
    const s = p.listSessions().find((x) => x.id === `bionic:${RUN}`);
    expect(s).toMatchObject({ live: true, status: "busy" });
    const tree = p.getSession(RUN)?.tree;
    expect(tree?.state).toBe("running");
    expect(tree?.lastAction).toMatchObject({ kind: "agent", tool: "agentic_find", target: "where is auth" });
    expect(p.machine().liveSessions).toBe(3); // RUN, IDLE, TRANS_LIVE (its open user turn)
    expect(p.machine().runningAgents).toBe(2); // RUN, TRANS_LIVE
  });

  it("idle: updated within 10 min but no open turn", async () => {
    const p = await scanned();
    expect(p.listSessions().find((x) => x.id === `bionic:${IDLE}`)).toMatchObject({ live: true, status: "idle" });
    expect(p.getSession(IDLE)?.tree.state).toBe("idle");
  });

  it("an open turn that stopped updating for >2 min is idle, then done after 10 min", async () => {
    const p3 = await scanned(NOW + 3 * MIN);
    expect(p3.getSession(RUN)?.tree.state).toBe("idle");
    expect(p3.listSessions().find((x) => x.id === `bionic:${RUN}`)?.live).toBe(true);
    const p20 = await scanned(NOW + 20 * MIN);
    expect(p20.getSession(RUN)?.tree.state).toBe("done");
    expect(p20.listSessions().find((x) => x.id === `bionic:${RUN}`)).toMatchObject({ live: false });
    expect(p20.machine().liveSessions).toBe(0);
  });

  it("done / failed by the last entry; transient roots are listed only while live", async () => {
    const p = await scanned();
    expect(p.getSession(OLDROOT)?.tree.state).toBe("done");
    const err = p.getSession(ERR)?.tree;
    expect(err).toMatchObject({ state: "failed", endReason: "Hata: quota" });
    expect(p.listSessions().some((s) => s.id === `bionic:${TRANS_LIVE}`)).toBe(true);
    const later = await scanned(NOW + 30 * MIN);
    expect(later.listSessions().some((s) => s.id === `bionic:${TRANS_LIVE}`)).toBe(false);
  });
});

describe("bionic: events", () => {
  it("maps text, reasoning, tool calls and results; masks secrets", async () => {
    const p = await scanned();
    const r = await p.readEvents(RUN, "main", { tail: 50 });
    expect(r).toBeDefined();
    const ev = r?.events ?? [];
    expect(ev.map((e) => e.kind)).toEqual(["user", "thinking", "assistant", "tool_use", "tool_result", "tool_use", "tool_result", "notification", "notification", "user", "tool_use"]);
    const bash = ev.find((e) => e.kind === "tool_use" && e.tool === "shell_command");
    expect(bash).toMatchObject({ action: "bash", toolUseId: "c1" });
    expect(bash?.text).toContain("npm test");
    expect(bash?.text.startsWith("cd ")).toBe(false);
    expect(ev.find((e) => e.kind === "tool_result")).toMatchObject({ toolUseId: "c1", text: "12 passed" });
    expect(ev.find((e) => e.tool === "read_file_lines")).toMatchObject({ action: "read", detail: { file_path: "/work/demo/src/a.ts" } });
    expect(ev.some((e) => e.kind === "notification" && e.text.startsWith("Tur tamamlandı"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(p.listSessions())).not.toContain(SECRET);
    expect(r?.truncated).toBe(false);
    expect(r?.cursor).toBe(ev.length);
  });

  it("pages with tail/before and follows with after (event-count cursors)", async () => {
    const p = await scanned();
    const tail = await p.readEvents(RUN, "main", { tail: 3 });
    expect(tail?.events).toHaveLength(3);
    expect(tail?.truncated).toBe(true);
    const older = await p.readEvents(RUN, "main", { tail: 3, before: tail?.start });
    expect(older?.events).toHaveLength(3);
    expect(older?.cursor).toBe(tail?.cursor);
    const all = await p.readEvents(RUN, "main", { tail: 1000 });
    expect([...(older?.events ?? []), ...(tail?.events ?? [])].map((e) => e.id)).toEqual((all?.events ?? []).slice(-6).map((e) => e.id));
    const none = await p.readEvents(RUN, "main", { after: all?.cursor ?? 0 });
    expect(none).toMatchObject({ events: [], reset: false });
    const some = await p.readEvents(RUN, "main", { after: (all?.cursor ?? 0) - 2 });
    expect(some?.events).toHaveLength(2);
    const reset = await p.readEvents(RUN, "main", { after: 9999 });
    expect(reset?.reset).toBe(true);
  });

  it("reads a sub-session's events by agent key and rejects foreign keys", async () => {
    const p = await scanned();
    const k = await p.readEvents(RUN, KID, { tail: 20 });
    expect(k?.events.map((e) => e.kind)).toEqual(["user", "tool_use", "tool_result", "assistant", "notification"]);
    expect(k?.events[1]).toMatchObject({ action: "search", detail: { pattern: "*.ts" } });
    expect(await p.readEvents(RUN, IDLE, { tail: 5 })).toBeUndefined();
    expect(await p.readEvents(RUN, "nope", { tail: 5 })).toBeUndefined();
    expect(await p.readEvents(KID, "main", { tail: 5 })).toBeUndefined();
  });
});

describe("bionic: read-only and file access", () => {
  it("sees data still in the WAL, leaves the database file untouched, and emits change once", async () => {
    const before = await sha(dbFile1);
    const p = make();
    const changes: string[][] = [];
    p.onChange((ids) => changes.push(ids));
    await p.scan(true);
    expect(p.listSessions().length).toBe(5); // rows live only in the -wal file (autocheckpoint off)
    await p.scan(false);
    expect(await sha(dbFile1)).toBe(before);
    expect(changes).toHaveLength(1);
  });

  it("never leaks the sentinel files next to projects/ into any output", async () => {
    const p = await scanned();
    const out = JSON.stringify([p.listSessions(), p.status(), p.getSession(RUN), await p.readEvents(RUN, "main", { tail: 1000 })]);
    expect(out).not.toContain(SENTINEL);
  });

  it("allows exactly project.json and ng-sessions.sqlite of a project", () => {
    expect(allowedBionicFile(join(projectsDir, P1, "project.json"), projectsDir)).toBe(true);
    expect(allowedBionicFile(join(projectsDir, P1, ".internal", "ng-sessions.sqlite"), projectsDir)).toBe(true);
  });

  it("denies settings.json, mcp.json, app support, other files, traversal and look-alikes", () => {
    const deny = [
      join(home, "settings.json"),
      join(home, "hf-token.json"),
      join(home, "mcp.json"),
      "/Users/u/.lmstudio/mcp.json",
      "/Users/u/.lmstudio/apps/bionic/settings.json",
      "/Users/u/.lmstudio/settings.json",
      "/Users/u/Library/Application Support/Bionic/Local Storage/leveldb/000003.log",
      "/Users/u/Library/Application Support/Bionic/Cookies",
      join(projectsDir, P1, "settings.json"),
      join(projectsDir, P1, ".internal", "other.sqlite"),
      join(projectsDir, P1, ".internal", "ng-sessions.sqlite-wal"),
      join(projectsDir, P1, ".internal", "ng-sessions.sqlite-shm"),
      join(projectsDir, P1, "nested", "project.json"),
      join(projectsDir, P1, ".internal", "sub", "ng-sessions.sqlite"),
      join(projectsDir, "not-a-uuid", "project.json"),
      join(projectsDir, "project.json"),
      join(projectsDir, P1, "..", "..", "settings.json"),
      join(projectsDir, P1, ".internal", "..", "..", "..", "settings.json"),
      `${projectsDir}/${P1}/../${P2}/../../settings.json`,
      join(projectsDir, P1, "project.json.bak"),
      join(projectsDir, P1),
      projectsDir,
      "",
    ];
    for (const p of deny) expect(allowedBionicFile(p, projectsDir), p).toBe(false);
    // The generic deny-list still applies on top.
    expect(isDeniedPath(join(home, "hf-token.json"))).toBe(true);
    expect(safeToRead(join(home, "settings.json"), [projectsDir])).toBe(false);
  });
});
