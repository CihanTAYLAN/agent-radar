import { appendFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexProvider } from "../src/providers/codex/provider.js";
import {
  cleanTitle,
  describeCall,
  parseSource,
  patchFiles,
  peekHead,
  rolloutThreadId,
  stateDbVersion,
  toEvents,
  toUsage,
  worthParsing,
} from "../src/providers/codex/format.js";
import { openAiCostUsd, openAiPrice } from "../src/pricing.js";
import type { AgentNode } from "../src/providers/types.js";
import { AUTH_SENTINEL, C_NOW, CHILD, CLI, GRAND, OLD, ROOT, SECRET, SNEAKY, T_END, makeCodexHome } from "./codex-helpers.js";

const flat = (n: AgentNode, out: AgentNode[] = []): AgentNode[] => {
  out.push(n);
  n.children.forEach((c) => flat(c, out));
  return out;
};

let homes: string[] = [];
afterEach(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
  homes = [];
});

async function setup(opts: { withDb?: boolean; now?: number } = {}): Promise<{ p: CodexProvider; home: string; files: Record<string, string> }> {
  const { home, files } = await makeCodexHome(opts);
  homes.push(home);
  const now = opts.now ?? C_NOW;
  const p = new CodexProvider({ codexHome: home, recentMs: 24 * 3600_000, watch: false, now: () => now, useDb: opts.withDb !== false, userHome: "/nonexistent-home" });
  await p.scan(true);
  return { p, home, files };
}

describe("codex format", () => {
  it("recognises rollout and index file names only", () => {
    expect(rolloutThreadId(`rollout-2026-03-10T10-01-00-${ROOT}.jsonl`)).toBe(ROOT);
    expect(rolloutThreadId("rollout-x.jsonl")).toBeNull();
    expect(rolloutThreadId("auth.json")).toBeNull();
    expect(stateDbVersion("state_5.sqlite")).toBe(5);
    for (const n of ["thread_history_1.sqlite", "logs_2.sqlite", "state_5.sqlite-wal", "goals_1.sqlite"]) expect(stateDbVersion(n)).toBeUndefined();
  });

  it("peeks line headers and skips huge irrelevant lines", () => {
    const l = JSON.stringify({ timestamp: "2026-03-10T10:00:00.000Z", ordinal: 3, type: "event_msg", payload: { type: "item_completed", item: { x: "y".repeat(300 * 1024) } } });
    expect(peekHead(l)).toEqual({ ts: "2026-03-10T10:00:00.000Z", type: "event_msg", ptype: "item_completed" });
    expect(worthParsing(l)).toBe(false);
    const u = JSON.stringify({ timestamp: "2026-03-10T10:00:00.000Z", ordinal: 4, type: "token_usage_record", payload: { pad: "z".repeat(300 * 1024) } });
    expect(worthParsing(u)).toBe(true); // usage is always parsed, however long
  });

  it("maps OpenAI usage (input includes cached) to the neutral shape", () => {
    expect(toUsage({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 100 })).toEqual({ input: 400, cacheRead: 600, cacheCreate: 0, output: 100 });
    expect(toUsage({})).toBeUndefined();
    expect(toUsage("x")).toBeUndefined();
  });

  it("parses thread sources (string, object and JSON text)", () => {
    expect(parseSource("vscode").kind).toBe("desktop");
    expect(parseSource("exec").kind).toBe("exec");
    const s = parseSource(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 2, agent_nickname: "Kuhn", agent_path: "/root/x" } } }));
    expect(s).toMatchObject({ kind: "subagent", parentId: ROOT, depth: 2, nickname: "Kuhn", agentPath: "/root/x" });
    expect(parseSource("{broken").kind).toBe("other");
  });

  it("cleans stored titles", () => {
    expect(cleanTitle("/goal&#x20;\n\n\nShip &amp; test")).toBe("/goal Ship & test");
    expect(cleanTitle("")).toBeUndefined();
  });

  it("humanises exec scripts, patches, shells and collaboration calls", () => {
    const ex = describeCall({ type: "custom_tool_call", call_id: "c1", name: "exec", input: `await tools.exec_command({cmd:"cd /w/p && TOKEN=${SECRET} npm test","workdir":"/w/p"})` })!;
    expect(ex.action.kind).toBe("bash");
    expect(ex.action.target).toBe("TOKEN=[REDACTED] npm test");
    expect(ex.action.dir).toBe("/w/p");
    expect(JSON.stringify(ex)).not.toContain(SECRET);

    const patch = "*** Begin Patch\n*** Update File: /w/p/src/a.ts\n@@\n-a\n+b\n*** Add File: /w/p/b.ts\n+x\n*** End Patch";
    const pc = describeCall({ type: "custom_tool_call", call_id: "c2", name: "exec", input: `const patch = ${JSON.stringify(patch)}; await tools.apply_patch(patch);` })!;
    expect(pc.action).toMatchObject({ kind: "edit", tool: "apply_patch", target: "a.ts, b.ts" });
    expect(pc.detail?.["patch"]).toBe(patch);
    expect(patchFiles(patch)).toEqual([{ op: "Update", path: "/w/p/src/a.ts" }, { op: "Add", path: "/w/p/b.ts" }]);

    const sh = describeCall({ type: "function_call", name: "shell", call_id: "c3", arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"], workdir: "/w" }) })!;
    expect(sh.action).toMatchObject({ kind: "bash", target: "ls -la", dir: "/w" });

    const sp = describeCall({ type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "c4", arguments: JSON.stringify({ task_name: "audit", message: "gAAAAencrypted" }) })!;
    expect(sp.action).toMatchObject({ kind: "agent", target: "audit", tool: "collaboration.spawn_agent" });
    const msg = describeCall({ type: "function_call", name: "send_message", namespace: "collaboration", call_id: "c5", arguments: JSON.stringify({ target: "audit", message: "gAAAAencrypted" }) })!;
    expect(msg.action.kind).toBe("message");
    expect(JSON.stringify(msg)).not.toContain("gAAAA");
    const mcp = describeCall({ type: "function_call", name: "js", namespace: "mcp__cua_repl", call_id: "c6", arguments: JSON.stringify({ code: "await x()", title: "Check tabs" }) })!;
    expect(mcp.action).toMatchObject({ kind: "mcp", tool: "mcp__cua_repl__js", target: "cua_repl · js: Check tabs" });
    expect(describeCall({ type: "message" })).toBeUndefined();
  });

  it("emits events without developer text, encrypted payloads or instructions", () => {
    const ev = (o: Record<string, unknown>) => toEvents(o, "b0");
    expect(ev({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "SECRET RULES" }] } })).toEqual([]);
    expect(ev({ type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "ENC" } })).toEqual([]);
    const th = ev({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "ENC" } });
    expect(th).toEqual([{ id: "b0:0", kind: "thinking", text: "plan" }]);
    const am = ev({ type: "response_item", payload: { type: "agent_message", content: [{ type: "input_text", text: "Task: x" }, { type: "encrypted_content", encrypted_content: "ENC" }] } });
    expect(am[0]).toMatchObject({ kind: "user", text: "Task: x" });
    const out = ev({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: `fail ${SECRET}`, metadata: { exit_code: 2 } }) } });
    expect(out[0]).toMatchObject({ kind: "tool_result", toolUseId: "c1", isError: true });
    expect(out[0]?.text).not.toContain(SECRET);
    expect(ev({ type: "session_meta", payload: { base_instructions: "x" } })).toEqual([]);
    expect(ev({ type: "event_msg", payload: { type: "task_complete", duration_ms: 65000 } })[0]?.text).toBe("Tur tamamlandı · 1 dk 05 sn");
  });

  it("prices OpenAI models by exact pattern, never by substring", () => {
    expect(openAiPrice("gpt-5")?.verified).toBe(false);
    expect(openAiPrice("gpt-5-codex")?.output).toBe(10);
    expect(openAiPrice("gpt-5-2025-08-07")).toBeDefined();
    expect(openAiPrice("gpt-5.6-luna-pro")).toBeUndefined();
    expect(openAiPrice("gpt-6-sol-pro")).toBeUndefined();
    expect(openAiCostUsd("gpt-9", { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 })).toBeUndefined();
    expect(openAiCostUsd("gpt-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 0 })).toBeCloseTo(1.25 + 10 + 0.125, 10);
  });
});

describe("codex provider (with the SQLite index)", () => {
  it("lists root threads as sessions with namespaced ids, and nothing outside the window", async () => {
    const { p } = await setup();
    const list = p.listSessions();
    expect(list.map((s) => s.id).sort()).toEqual([`codex:${ROOT}`, `codex:${CLI}`].sort());
    expect(list.every((s) => s.provider === "codex")).toBe(true);
    expect(list.some((s) => s.id.includes(OLD) || s.id.includes(SNEAKY))).toBe(false);
    const s = list.find((x) => x.id === `codex:${ROOT}`)!;
    expect(s).toMatchObject({ live: true, status: "busy", name: "Fix the build", cwd: "/tmp/cx-demo/proj", model: "gpt-5", agentCount: 2, runningAgents: 0, gitBranch: "main", entrypoint: "Codex Desktop", version: "0.99.0-test", kind: "desktop" });
  });

  it("aggregates usage once per response id and prices known models; unknown ones make it partial", async () => {
    const { p } = await setup();
    const d = p.getSession(ROOT)!;
    const nodes = flat(d.tree);
    const main = nodes[0]!;
    expect(main.usage).toEqual({ input: 900, cacheRead: 2100, cacheCreate: 0, output: 150 });
    expect(main.costUsd).toBeCloseTo((900 * 1.25 + 150 * 10 + 2100 * 0.125) / 1e6, 12);
    expect(main.costPartial).toBeUndefined();
    const grand = nodes.find((n) => n.key === GRAND)!;
    expect(grand.costPartial).toBe(true);
    expect(d.costPartial).toBe(true);
    expect(d.costByModel["gpt-9-imaginary"]).toBeNull();
    expect(d.costByModel["gpt-5-mini"]).toBeCloseTo((500 * 0.25 + 40 * 2) / 1e6, 12);
    expect(d.usageSubagents.output).toBe(40 + 30);
    // token_count fallback (no token_usage_record in that rollout): deltas of the running total.
    expect(p.getSession(CLI)!.usage).toEqual({ input: 200, cacheRead: 50, cacheCreate: 0, output: 30 });
  });

  it("nests subagents recursively and links spawn calls", async () => {
    const { p } = await setup();
    const t = p.getSession(ROOT)!.tree;
    expect(t.key).toBe("main");
    expect(t.children.map((c) => c.key)).toEqual([CHILD]);
    const child = t.children[0]!;
    expect(child).toMatchObject({ label: "review_task", agentType: "Hopper", model: "gpt-5-mini", state: "done", parentKey: "main", spawnDepth: 1, toolUseId: "call_spawn1", provider: "codex" });
    expect(child.children.map((c) => c.key)).toEqual([GRAND]);
    expect(child.children[0]).toMatchObject({ label: "deep_check", state: "stopped", parentKey: CHILD, endReason: "Tur iptal edildi" });
    expect(p.getSession(CHILD)).toBeUndefined(); // a subagent is not a session of its own
  });

  it("derives running / idle / done from open turns and rollout mtime", async () => {
    const { p, files } = await setup();
    let main = p.getSession(ROOT)!.tree;
    expect(main.state).toBe("running");
    expect(main.lastAction).toMatchObject({ kind: "bash", target: "cargo build --release", dir: "/tmp/cx-demo/proj" });

    // Turn completes -> idle while the rollout is fresh.
    await appendFile(files[ROOT]!, JSON.stringify({ timestamp: new Date(T_END + 5000).toISOString(), ordinal: 999, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } }) + "\n");
    await utimes(files[ROOT]!, new Date(T_END + 5000), new Date(T_END + 5000));
    await p.scan();
    main = p.getSession(ROOT)!.tree;
    expect(main.state).toBe("idle");
    expect(main.lastAction).toBeUndefined();
    expect(p.listSessions().find((s) => s.id === `codex:${ROOT}`)).toMatchObject({ live: true, status: "idle" });

    // Much later: done, not live.
    const later = new CodexProvider({ codexHome: p.home, watch: false, now: () => T_END + 3 * 60_000 });
    await later.scan(true);
    expect(later.getSession(ROOT)!.tree.state).toBe("done");
    expect(later.listSessions().find((s) => s.id === `codex:${ROOT}`)?.live).toBe(false);
  });

  it("treats an open turn in a stale rollout as not running", async () => {
    const { home } = await setup();
    const p = new CodexProvider({ codexHome: home, watch: false, now: () => T_END + 11 * 60_000 });
    await p.scan(true);
    expect(p.getSession(ROOT)!.tree.state).toBe("done");
  });

  it("serves events by byte cursor, masked, without encrypted or instruction content", async () => {
    const { p, files } = await setup();
    const r = (await p.readEvents(ROOT, "main", { tail: 100 }))!;
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("notification");
    const all = JSON.stringify(r);
    for (const bad of [SECRET, "ENCRYPTED-REASONING-NEVER-SHOWN", "BASE-INSTRUCTIONS-NEVER-SHOWN", "DEVELOPER-INSTRUCTIONS-HIDDEN", "environment_context"]) expect(all).not.toContain(bad);
    const user = r.events.find((e) => e.kind === "user")!;
    expect(user.text).toBe("Fix the build please");
    const patch = r.events.find((e) => e.tool === "apply_patch")!;
    expect(patch).toMatchObject({ action: "edit", toolUseId: "call_patch1" });
    expect(patch.detail?.["patch"]).toContain("+const a = 2;");
    const exec = r.events.find((e) => e.toolUseId === "call_exec1" && e.kind === "tool_use")!;
    expect(exec).toMatchObject({ tool: "exec_command", action: "bash" });
    expect(r.events.find((e) => e.toolUseId === "call_exec1" && e.kind === "tool_result")?.text).toContain("3 passing");
    expect(new Set(r.events.map((e) => e.id)).size).toBe(r.events.length);

    const none = (await p.readEvents(ROOT, "main", { after: r.cursor }))!;
    expect(none.events).toEqual([]);
    await appendFile(files[ROOT]!, JSON.stringify({ timestamp: new Date(T_END + 1000).toISOString(), ordinal: 1000, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `new ${SECRET}` }] } }) + "\n");
    const more = (await p.readEvents(ROOT, "main", { after: r.cursor }))!;
    expect(more.events).toHaveLength(1);
    expect(more.events[0]?.text).toBe("new sk-[REDACTED]");

    const sub = (await p.readEvents(ROOT, CHILD, { tail: 10 }))!;
    expect(sub.events[0]).toMatchObject({ kind: "user" });
    expect(JSON.stringify(sub)).not.toContain("ENCRYPTED-AGENT-MSG");
    expect(await p.readEvents(ROOT, OLD, { tail: 10 })).toBeUndefined(); // not in this session's tree
    expect(await p.readEvents(CLI, CHILD, { tail: 10 })).toBeUndefined();
  });

  it("never reads auth/config files, even when the index points at them", async () => {
    const { p, home } = await setup();
    const everything = JSON.stringify([p.listSessions(), p.getSession(ROOT), p.getSession(CLI), p.status(), p.machine(), await p.readEvents(ROOT, "main", { tail: 1000 })]);
    expect(everything).not.toContain(AUTH_SENTINEL);
    expect(p.getSession(SNEAKY)).toBeUndefined();
    expect(p.status().notes.join(" ")).toMatch(/atlandı/);
    expect(await readFile(join(home, "auth.json"), "utf8")).toContain(AUTH_SENTINEL); // fixture sanity
  });

  it("reports provider health and machine counters", async () => {
    const { p } = await setup();
    const st = p.status();
    expect(st).toMatchObject({ id: "codex", label: "Codex", mark: "CX", installed: true, dataFound: true, sessions: 2, active: 1 });
    expect(st.capabilities).toEqual({ transcript: true, tokens: true, tools: true, subagents: true, cost: true });
    expect(st.notes.join(" ")).toMatch(/state_5\.sqlite/);
    expect(st.notes.join(" ")).toMatch(/gpt-9-imaginary/);
    const m = p.machine();
    expect(m.liveSessions).toBe(1);
    expect(m.runningAgents).toBe(1);
    expect(m.finishedToday).toBe(2); // child (done) + grandchild (stopped)
    expect(m.outputToday).toBe(150 + 40 + 30 + 30);
  });
});

describe("codex provider (rollout-only fallback)", () => {
  it("discovers recent rollouts and links subagents via session_meta", async () => {
    const { p } = await setup({ withDb: false });
    expect(p.listSessions().map((s) => s.id).sort()).toEqual([`codex:${ROOT}`, `codex:${CLI}`].sort());
    const t = p.getSession(ROOT)!.tree;
    expect(t.children.map((c) => c.key)).toEqual([CHILD]);
    expect(t.children[0]?.children.map((c) => c.key)).toEqual([GRAND]);
    expect(p.status().notes.join(" ")).toMatch(/yalnızca rollout/);
    // Without the index title, the name falls back to the last user prompt.
    expect(p.listSessions().find((s) => s.id === `codex:${ROOT}`)?.name).toBe("Fix the build please");
  });

  it("handles a missing home gracefully", async () => {
    const p = new CodexProvider({ codexHome: "/nonexistent/codex-home", watch: false, now: () => C_NOW });
    await p.scan(true);
    expect(p.listSessions()).toEqual([]);
    expect(p.status()).toMatchObject({ installed: false, dataFound: false, sessions: 0, active: 0 });
  });
});
