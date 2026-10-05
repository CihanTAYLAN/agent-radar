import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kilo, opencode } from "../src/providers/opencode/index.js";
import { OpencodeProvider } from "../src/providers/opencode/provider.js";
import { describeTool, isNativeId } from "../src/providers/opencode/format.js";
import { createProviders } from "../src/providers/index.js";
import { safeToRead } from "../src/providers/guard.js";
import { AUTH_SENTINEL, CHILD, FAILED, O_NOW, OLD, ROOT, SECRET, makeOpencodeHome, type OpencodeFixture } from "./opencode-helpers.js";

let fx: OpencodeFixture;
let p: OpencodeProvider;

function mk(recentMs = 24 * 3600_000): OpencodeProvider {
  return new OpencodeProvider({ id: "opencode", label: "opencode", mark: "OC", dbPath: fx.db, now: () => O_NOW, recentMs });
}

beforeAll(async () => {
  fx = await makeOpencodeHome();
  p = mk();
  await p.scan(true);
});
afterAll(async () => {
  p.stop();
  await rm(dirname(fx.dir), { recursive: true, force: true });
});

describe("opencode provider", () => {
  it("lists root sessions in the recent window with namespaced ids", () => {
    const ids = p.listSessions().map((s) => s.id).sort();
    expect(ids).toEqual([`opencode:${FAILED}`, `opencode:${ROOT}`].sort());
    expect(ids).not.toContain(`opencode:${OLD}`);
    expect(ids).not.toContain(`opencode:${CHILD}`);
  });

  it("summarizes tokens, recorded cost, live state and last prompt", () => {
    const s = p.listSessions().find((x) => x.id === `opencode:${ROOT}`)!;
    expect(s.provider).toBe("opencode");
    expect(s.live).toBe(true);
    expect(s.status).toBe("busy");
    expect(s.name).toBe("Refactor the parser");
    expect(s.lastPrompt).toBe("Please refactor the parser module");
    expect(s.costUsd).toBeCloseTo(0.35, 5);
    expect(s.costPartial).toBeUndefined();
    // root: 1000 in, 400+100 out, 5000 read, 200 write; child: 200, 100, 1000
    expect(s.usage).toEqual({ input: 1200, output: 600, cacheRead: 6000, cacheCreate: 200 });
    expect(s.agentCount).toBe(1);
    expect(s.runningAgents).toBe(0);
    expect(s.model).toBe("glm-4.7-free");
  });

  it("nests child sessions as subagents and links the spawning call", () => {
    const d = p.getSession(ROOT)!;
    expect(d.tree.key).toBe("main");
    expect(d.tree.state).toBe("running");
    expect(d.tree.children).toHaveLength(1);
    const c = d.tree.children[0]!;
    expect(c.key).toBe(CHILD);
    expect(c.agentType).toBe("explore");
    expect(c.state).toBe("done");
    expect(c.parentKey).toBe("main");
    expect(c.toolUseId).toBe("call_task");
    expect(c.toolCalls).toBe(1);
    expect(d.tree.toolCalls).toBe(4);
    expect(d.costByModel["glm-4.7-free"]).toBeCloseTo(0.35, 5);
    expect(p.getSession(CHILD)).toBeUndefined();
  });

  it("humanizes the running tool as the current action, masked", () => {
    const main = p.getSession(ROOT)!.tree;
    expect(main.lastAction?.kind).toBe("bash");
    expect(main.lastAction?.target).toBe("npm test --token=[REDACTED]");
    expect(main.lastAction?.dir).toBe("/tmp/oc-demo/proj");
    expect(main.lastTool).toBe("bash");
    expect(JSON.stringify(main)).not.toContain(SECRET);
  });

  it("marks an errored last turn as failed with the reason", () => {
    const d = p.getSession(FAILED)!;
    expect(d.live).toBe(false);
    expect(d.tree.state).toBe("failed");
    expect(d.tree.endReason).toBe("Model not supported");
  });

  it("serves events: text, reasoning, tools with results; masks secrets; hides unsettled parts", async () => {
    const r = (await p.readEvents(ROOT, "main", { tail: 100 }))!;
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toEqual(["user", "thinking", "assistant", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result"]);
    const text = JSON.stringify(r.events);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("SYNTHETIC-SYSTEM-REMINDER");
    expect(text).not.toContain("streaming, not finished");
    expect(text).not.toContain("npm test");
    const read = r.events.find((e) => e.tool === "read")!;
    expect(read.action).toBe("read");
    expect(read.detail?.["file_path"]).toBe("/tmp/oc-demo/proj/src/parser.ts");
    const bad = r.events.filter((e) => e.kind === "tool_result").at(-1)!;
    expect(bad.isError).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.reset).toBe(false);
    expect(r.cursor).toBeGreaterThan(0);
  });

  it("pages older events and follows with an after cursor", async () => {
    const newest = (await p.readEvents(ROOT, "main", { tail: 3 }))!;
    expect(newest.events.map((e) => e.kind)).toEqual(["tool_use", "tool_result"]);
    expect(newest.truncated).toBe(true);
    const older = (await p.readEvents(ROOT, "main", { tail: 100, before: newest.start }))!;
    const ids = new Set([...newest.events, ...older.events].map((e) => e.id));
    expect(ids.size).toBe(newest.events.length + older.events.length);
    const all = (await p.readEvents(ROOT, "main", { tail: 100 }))!;
    expect(ids.size).toBe(all.events.length);
    const none = (await p.readEvents(ROOT, "main", { after: all.cursor }))!;
    expect(none.events).toEqual([]);
    expect(none.cursor).toBe(all.cursor);
    const everything = (await p.readEvents(ROOT, "main", { after: 0 }))!;
    expect(everything.events.length).toBe(all.events.length);
  });

  it("reads a subagent's events and rejects unknown agents or ids", async () => {
    const c = (await p.readEvents(ROOT, CHILD, { tail: 10 }))!;
    expect(c.events.map((e) => e.tool)).toEqual(["grep", undefined]);
    expect(await p.readEvents(ROOT, OLD, { tail: 10 })).toBeUndefined();
    expect(await p.readEvents("ses_NOPE0000000", "main", { tail: 10 })).toBeUndefined();
    expect(p.isSessionId(ROOT)).toBe(true);
    expect(p.isSessionId("../../auth.json")).toBe(false);
    expect(isNativeId("ses_x'; DROP TABLE session;--")).toBe(false);
  });

  it("reports status with last activity even when nothing is in the window", async () => {
    const q = mk(1000);
    await q.scan(true);
    const st = q.status();
    expect(st.mark).toBe("OC");
    expect(st.installed).toBe(true);
    expect(st.dataFound).toBe(true);
    expect(st.lastActivityAt).toBe(O_NOW - 10_000);
    expect(st.capabilities).toEqual({ transcript: true, tokens: true, tools: true, subagents: true, cost: true });
    expect(q.listSessions().map((s) => s.id)).toEqual([`opencode:${ROOT}`]); // still running -> kept live
    const old = new OpencodeProvider({ id: "opencode", label: "opencode", mark: "OC", dbPath: fx.db, now: () => O_NOW + 30 * 24 * 3600_000, recentMs: 1000 });
    await old.scan(true);
    expect(old.listSessions()).toEqual([]);
    expect(old.status().dataFound).toBe(true);
    expect(old.status().lastActivityAt).toBe(O_NOW - 10_000);
  });

  it("degrades to an honest status when the database is missing", async () => {
    const q = new OpencodeProvider({ id: "opencode", label: "opencode", mark: "OC", dbPath: `${fx.dir}/nope.db`, now: () => O_NOW });
    await q.scan(true);
    const st = q.status();
    expect(st.dataFound).toBe(false);
    expect(st.sessions).toBe(0);
    expect(q.listSessions()).toEqual([]);
    expect(q.loading).toBe(false);
  });

  it("emits change when a running turn finishes (rows update in place)", async () => {
    const mod = await import("../src/providers/sqlite.js").then((m) => m.loadSqlite());
    const w = new mod!.DatabaseSync(fx.db);
    const q = mk();
    await q.scan(true);
    const seen: string[][] = [];
    q.onChange((ids) => seen.push(ids));
    w.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = 'msg_a1'").run(
      JSON.stringify({ role: "assistant", modelID: "glm-4.7-free", time: { created: O_NOW - 19 * 60_000, completed: O_NOW - 1000 } }),
      O_NOW - 1000,
    );
    w.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(O_NOW - 1000, ROOT);
    w.close();
    await q.scan(false);
    expect(seen.flat()).toContain(`opencode:${ROOT}`);
    expect(q.getSession(ROOT)!.tree.state).toBe("idle");
    expect(q.getSession(ROOT)!.tree.lastAction).toBeUndefined();
  });

  it("never modifies the database file and never reads auth.json", async () => {
    // (runs after the in-place update test above wrote through its own handle; compare via a fresh fixture)
    const f2 = await makeOpencodeHome();
    const s0 = await stat(f2.db);
    const q = new OpencodeProvider({ id: "opencode", label: "opencode", mark: "OC", dbPath: f2.db, now: () => O_NOW });
    await q.scan(true);
    await q.readEvents(ROOT, "main", { tail: 50 });
    const s1 = await stat(f2.db);
    expect(s1.size).toBe(s0.size);
    expect(s1.mtimeMs).toBe(s0.mtimeMs);
    expect(safeToRead(`${f2.dir}/auth.json`, [f2.db])).toBe(false);
    expect(JSON.stringify(q.listSessions()) + JSON.stringify(q.getSession(ROOT))).not.toContain(AUTH_SENTINEL);
    expect(await readFile(`${f2.dir}/auth.json`, "utf8")).toContain(AUTH_SENTINEL);
    await rm(dirname(f2.dir), { recursive: true, force: true });
  });
});

describe("format", () => {
  it("humanizes tool calls into kinds", () => {
    expect(describeTool("bash", { command: "cd /a && ls -la" }).action).toEqual({ tool: "bash", kind: "bash", target: "ls -la", dir: "/a" });
    expect(describeTool("edit", { filePath: "/a/b/c/d/e.ts", oldString: "x", newString: "y" }).detail).toMatchObject({ file_path: "/a/b/c/d/e.ts", old_string: "x", new_string: "y" });
    expect(describeTool("write", { filePath: "/a.ts" }).action.kind).toBe("write");
    expect(describeTool("glob", { pattern: "**/*.ts" }).action.kind).toBe("search");
    expect(describeTool("task", { description: "Look around" }).action).toMatchObject({ kind: "agent", target: "Look around" });
    expect(describeTool("playwright_browser_navigate", { url: "https://x.test" }).action.kind).toBe("mcp");
    expect(describeTool("todowrite", {}).action.kind).toBe("todo");
  });
});

describe("registration", () => {
  it("registers opencode and Kilo Code from one implementation with separate DB paths", () => {
    const ctx = { env: {} as NodeJS.ProcessEnv, userHome: "/home/u", recentMs: 1000 };
    const a = opencode.create(ctx) as OpencodeProvider;
    const b = kilo.create(ctx) as OpencodeProvider;
    expect(a.dbPath).toBe("/home/u/.local/share/opencode/opencode.db");
    expect(b.dbPath).toBe("/home/u/.local/share/kilo/kilo.db");
    expect([a.id, b.id]).toEqual(["opencode", "kilo"]);
    expect(b.label).toBe("Kilo Code");
    const all = createProviders({ ...ctx, env: { XDG_DATA_HOME: "/x" } }).map((x) => x.id);
    expect(all).toEqual(expect.arrayContaining(["claude-code", "codex", "opencode", "kilo"]));
  });
});
