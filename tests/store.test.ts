import { appendFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_BUCKETS, Radar, activityBuckets, localDay, tickOffsets, type AgentNode } from "../src/store.js";
import { claudeCostUsd } from "../src/pricing.js";
import { S1, S2, T_LAST, T_NOW, makeHome } from "./helpers.js";

const costUsd = (m: string, u: Parameters<typeof claudeCostUsd>[1]): number => claudeCostUsd(m, u) ?? 0;

let home: string;
let livePid: number;
let deadPid: number;
let radar: Radar;

function mkRadar(extra: Partial<ConstructorParameters<typeof Radar>[0]> = {}): Radar {
  return new Radar({
    claudeHome: home,
    recentMs: 24 * 3600 * 1000,
    watch: false,
    now: () => T_NOW,
    pidAlive: (pid) => pid === livePid,
    ...extra,
  });
}

beforeEach(async () => {
  ({ home, livePid, deadPid } = await makeHome());
  radar = mkRadar();
  await radar.scan(true);
});
afterEach(async () => {
  radar.stop();
  await rm(home, { recursive: true, force: true });
});

const flat = (n: AgentNode, out: AgentNode[] = []): AgentNode[] => {
  out.push(n);
  n.children.forEach((c) => flat(c, out));
  return out;
};

describe("machine view", () => {
  it("lists the live session first, with registry data, and the dead one as not live", () => {
    const list = radar.listSessions();
    expect(list.map((s) => s.id)).toEqual([S1, S2]);
    const live = list[0]!;
    expect(live).toMatchObject({ live: true, status: "busy", name: "Demo Live", entrypoint: "cli", cwd: "/tmp/demo", pid: livePid, agentCount: 4 });
    const old = list[1]!;
    expect(old).toMatchObject({ live: false, name: "Old One", cwd: "/tmp/other", agentCount: 0 });
    expect(old.pid).toBeUndefined();
    expect(deadPid).toBeGreaterThan(0);
  });

  it("drops non-live sessions older than the recent window but keeps live ones", async () => {
    const old = new Date(T_LAST - 30 * 3600 * 1000);
    await utimes(join(home, "projects", "-tmp-other", `${S2}.jsonl`), old, old);
    const r = mkRadar({ recentMs: 24 * 3600 * 1000 });
    await r.scan(true);
    expect(r.listSessions().map((s) => s.id)).toEqual([S1]);
    const tooOld = new Date(T_LAST - 300 * 3600 * 1000);
    await utimes(join(home, "projects", "-tmp-demo", `${S1}.jsonl`), tooOld, tooOld);
    // The live session stays even when its transcript mtime is out of the window.
    const r2 = mkRadar();
    await r2.scan(true);
    expect(r2.listSessions().some((s) => s.id === S1 && s.live)).toBe(true);
  });

  it("falls back to the custom-title.json / transcript title when the registry has no name", async () => {
    const { rm: rmf } = await import("node:fs/promises");
    await rmf(join(home, "sessions", "1111.json"));
    const r = mkRadar();
    await r.scan(true);
    const s = r.listSessions().find((x) => x.id === S1)!;
    expect(s.live).toBe(false);
    expect(s.name).toBe("Demo Session"); // transcript custom-title line wins over custom-title.json
  });

  it("never reads *.key files, junk registry files or non-numeric names", () => {
    const json = JSON.stringify(radar.listSessions()) + JSON.stringify(radar.getSession(S1));
    expect(json).not.toContain("FIXTURE-KEY-FILE");
    expect(radar.listSessions()).toHaveLength(2);
  });
});

describe("agent tree", () => {
  it("nests subagents by the Agent tool_use that spawned them", () => {
    const d = radar.getSession(S1)!;
    expect(d.tree.key).toBe("main");
    expect(d.tree.children.map((c) => c.key)).toEqual(["a3", "a1", "w1"]);
    const a1 = d.tree.children.find((c) => c.key === "a1")!;
    expect(a1.children.map((c) => c.key)).toEqual(["a2"]);
    expect(a1.children[0]?.parentKey).toBe("a1");
    expect(a1.children[0]?.spawnDepth).toBe(2);
  });

  it("fills node details from meta.json, or from the parent's spawn when meta.json is missing", () => {
    const nodes = flat(radar.getSession(S1)!.tree);
    const by = (k: string) => nodes.find((n) => n.key === k)!;
    expect(by("a1")).toMatchObject({ label: "Build things", agentType: "vekil", mode: "background", worktreeBranch: "wt/demo" });
    expect(by("a2")).toMatchObject({ label: "Nested probe", agentType: "Explore", mode: "foreground" });
    // a3 has no meta.json: description/type/mode come from the Agent tool_use in the main transcript
    expect(by("a3")).toMatchObject({ label: "Quick check", agentType: "Explore", mode: "foreground" });
    // w1 lives in workflows/wf_demo, no toolUseId: hangs off main, mode unknown
    expect(by("w1")).toMatchObject({ workflow: "wf_demo", parentKey: "main", mode: "unknown", agentType: "Explore" });
  });

  it("infers states from the last entry, notifications and recency", () => {
    const nodes = flat(radar.getSession(S1)!.tree);
    const state = (k: string) => nodes.find((n) => n.key === k)?.state;
    expect(state("main")).toBe("running"); // alive + busy
    expect(state("a1")).toBe("done"); // end_turn + completed notification
    expect(state("a3")).toBe("done");
    expect(state("a2")).toBe("running"); // last entry is a tool_use, activity 60s ago
    expect(state("w1")).toBe("stopped"); // killed notification, nothing after it
  });

  it("separates failed from stopped, keeps the reason, and never pins a resumed agent", async () => {
    const mainFile = join(home, "projects", "-tmp-demo", `${S1}.jsonl`);
    const notify = (id: string, status: string, summary: string, ts: string) =>
      JSON.stringify({ type: "user", uuid: `n-${id}-${status}`, timestamp: ts, message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } }) + "\n";
    const node = (k: string) => flat(radar.getSession(S1)!.tree).find((n) => n.key === k)!;

    await appendFile(mainFile, notify("a2", "failed", 'Agent "Probe" failed: API error', "2026-01-01T10:03:10.000Z"));
    await radar.scan();
    expect(node("a2")).toMatchObject({ state: "failed", endReason: 'Agent "Probe" failed: API error' });
    expect(node("a1").endReason).toBeUndefined(); // completed agents carry no reason
    expect(node("w1").state).toBe("stopped"); // killed = stopped by the user, not a failure

    // Activity in the agent after the notification means it was resumed: running, not red.
    const a2File = join(home, "projects", "-tmp-demo", S1, "subagents", "agent-a2.jsonl");
    await appendFile(a2File, JSON.stringify({ type: "assistant", uuid: "z9", timestamp: "2026-01-01T10:03:50.000Z", isSidechain: true, agentId: "a2", message: { id: "m99", role: "assistant", model: "claude-haiku-4-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_Z9", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 1, output_tokens: 1 } } }) + "\n");
    await radar.scan();
    expect(node("a2").state).toBe("running");
    expect(node("a2").endReason).toBeUndefined();
  });

  it("marks an unfinished agent as stalled once it has been silent for a long time", async () => {
    const r = mkRadar({ now: () => T_NOW + 3 * 3600 * 1000 });
    await r.scan(true);
    const a2 = flat(r.getSession(S1)!.tree).find((n) => n.key === "a2")!;
    expect(a2.state).toBe("stalled");
  });

  it("computes durations and running counts", () => {
    const d = radar.getSession(S1)!;
    const a1 = flat(d.tree).find((n) => n.key === "a1")!;
    expect(a1.durationMs).toBe(Date.parse("2026-01-01T10:01:30Z") - Date.parse("2026-01-01T10:00:30Z"));
    expect(d.runningAgents).toBe(1); // a2 (main is not counted as a subagent)
  });
});

describe("usage", () => {
  it("counts each API message once even though it is written as several lines", () => {
    const d = radar.getSession(S1)!;
    // main: m1 (x2 lines) + m2 + m3
    expect(d.usageMain).toEqual({ input: 20, output: 10, cacheRead: 210, cacheCreate: 20 });
    expect(d.tree.messages).toBe(3);
  });

  it("lets the latest line of a message win (streamed usage grows)", () => {
    const a2 = flat(radar.getSession(S1)!.tree).find((n) => n.key === "a2")!;
    expect(a2.usage).toEqual({ input: 7, output: 7, cacheRead: 12, cacheCreate: 0 });
    expect(a2.messages).toBe(1);
  });

  it("sums per agent, per session and per model", () => {
    const d = radar.getSession(S1)!;
    const a1 = flat(d.tree).find((n) => n.key === "a1")!;
    expect(a1.usage).toEqual({ input: 50, output: 25, cacheRead: 500, cacheCreate: 40 });
    expect(d.usage).toEqual({ input: 82, output: 47, cacheRead: 772, cacheCreate: 60 });
    expect(d.totalTokens).toBe(961);
    expect(d.usageSubagents).toEqual({ input: 62, output: 37, cacheRead: 562, cacheCreate: 40 });
    expect(Object.keys(d.usageByModel).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"]);
    expect(d.usageByModel["claude-sonnet-5"]).toEqual({ input: 53, output: 28, cacheRead: 530, cacheCreate: 40 });
  });
});

describe("incremental tailing", () => {
  it("picks up appended lines without re-reading, tolerating a partial last line", async () => {
    const file = join(home, "projects", "-tmp-demo", S1, "subagents", "agent-a2.jsonl");
    const before = flat(radar.getSession(S1)!.tree).find((n) => n.key === "a2")!;
    const line =
      JSON.stringify({ type: "assistant", uuid: "t9", timestamp: "2026-01-01T10:03:30.000Z", sessionId: S1, message: { id: "m21", role: "assistant", model: "claude-haiku-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } }) + "\n";
    await appendFile(file, line.slice(0, 40)); // half a line: must be ignored for now
    await radar.scan();
    expect(flat(radar.getSession(S1)!.tree).find((n) => n.key === "a2")!.usage).toEqual(before.usage);
    await appendFile(file, line.slice(40));
    let changed: string[] = [];
    radar.once("change", (ids: string[]) => (changed = ids));
    await radar.scan();
    const after = flat(radar.getSession(S1)!.tree).find((n) => n.key === "a2")!;
    expect(after.usage.input).toBe(before.usage.input + 1);
    expect(after.state).toBe("done"); // last entry is now an end_turn
    expect(changed).toContain(S1);
  });

  it("discovers a subagent that appears later", async () => {
    const { writeFile } = await import("node:fs/promises");
    const dir = join(home, "projects", "-tmp-demo", S1, "subagents");
    await writeFile(join(dir, "agent-zz9.jsonl"), JSON.stringify({ type: "user", uuid: "n1", timestamp: "2026-01-01T10:03:40.000Z", message: { role: "user", content: "hi" } }) + "\n");
    await radar.scan(true);
    expect(radar.getSession(S1)!.agentCount).toBe(5);
    expect(flat(radar.getSession(S1)!.tree).some((n) => n.key === "zz9")).toBe(true);
  });
});

describe("events", () => {
  it("returns the tail of an agent transcript and a cursor for follow-ups", async () => {
    const r = (await radar.readEvents(S1, "a2", { tail: 50 }))!;
    expect(r.events.map((e) => e.kind)).toEqual(["user", "tool_use", "tool_use"]);
    expect(r.events[2]?.text).not.toContain("abcdefghijklmnopqrstuv"); // Bearer token masked
    expect(r.truncated).toBe(false);

    const none = (await radar.readEvents(S1, "a2", { after: r.cursor }))!;
    expect(none.events).toEqual([]);

    const file = join(home, "projects", "-tmp-demo", S1, "subagents", "agent-a2.jsonl");
    await appendFile(file, JSON.stringify({ type: "user", uuid: "r1", timestamp: "2026-01-01T10:03:40.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_B2", content: "total 0" }] } }) + "\n");
    const more = (await radar.readEvents(S1, "a2", { after: r.cursor }))!;
    expect(more.events).toHaveLength(1);
    expect(more.events[0]).toMatchObject({ kind: "tool_result", text: "total 0" });
    expect(more.cursor).toBeGreaterThan(r.cursor);
  });

  it("serves main-agent events with masked prompts and skips broken lines", async () => {
    const r = (await radar.readEvents(S1, "main", { tail: 100 }))!;
    const first = r.events.find((e) => e.kind === "user")!;
    expect(first.text).toContain("TOKEN=[REDACTED]");
    expect(first.text).not.toContain("abc123supersecretvalue");
    expect(r.events.some((e) => e.kind === "notification")).toBe(true);
  });

  it("limits tail size and returns undefined for unknown agents/sessions", async () => {
    const r = (await radar.readEvents(S1, "main", { tail: 2 }))!;
    expect(r.events).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(await radar.readEvents(S1, "nope", { tail: 5 })).toBeUndefined();
    expect(await radar.readEvents("cccccccc-0000-4000-8000-000000000003", "main", { tail: 5 })).toBeUndefined();
  });
});

describe("timeline data", () => {
  it("gives finished agents an end, running agents a structured current action, and tool ticks", () => {
    const nodes = flat(radar.getSession(S1)!.tree);
    const a1 = nodes.find((n) => n.key === "a1")!;
    expect(a1.state).toBe("done");
    expect(a1.endedAt).toBe(Date.parse("2026-01-01T10:01:30Z"));
    expect(a1.lastAction).toBeUndefined();
    expect(a1.ticks).toEqual([10]); // Agent tool_use 10s after start
    expect(a1.toolUseId).toBe("toolu_A1");

    const a2 = nodes.find((n) => n.key === "a2")!;
    expect(a2.state).toBe("running");
    expect(a2.endedAt).toBeUndefined();
    expect(a2.lastAction).toMatchObject({ tool: "Bash", kind: "bash" });
    expect(a2.lastAction?.target).not.toContain("abcdefghijklmnopqrstuv");
    expect(a2.ticks).toEqual([5]); // two tool_use lines at the same second collapse into one tick
  });

  it("dedupes, sorts and samples tick offsets", () => {
    expect(tickOffsets([3000, 1000, 1400, 1000], 1000)).toEqual([0, 2]);
    expect(tickOffsets([5000], undefined)).toEqual([]);
    expect(tickOffsets(Array.from({ length: 100 }, (_, i) => i * 1000), 0, 10)).toHaveLength(10);
  });

  it("buckets activity per minute, newest last", () => {
    const now = Date.parse("2026-01-01T10:04:30Z");
    const min = (iso: string) => Math.floor(Date.parse(iso) / 60000);
    const b = activityBuckets(new Map([[min("2026-01-01T10:04:10Z"), 3], [min("2026-01-01T10:02:00Z"), 2], [min("2026-01-01T09:00:00Z"), 9]]), now, 5);
    expect(b.end).toBe(Date.parse("2026-01-01T10:04:00Z"));
    expect(b.counts).toEqual([0, 0, 2, 0, 3]);
    const s = radar.listSessions().find((x) => x.id === S1)!;
    expect(s.activity.counts).toHaveLength(ACTIVITY_BUCKETS);
    expect(s.activity.counts.reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
  });
});

describe("cost", () => {
  it("estimates cost per agent, per model and per session from usage", () => {
    const d = radar.getSession(S1)!;
    const sum = Object.entries(d.usageByModel).reduce((c, [m, u]) => c + costUsd(m, u), 0);
    expect(d.costUsd).toBeCloseTo(sum, 12);
    expect(d.costByModel["claude-sonnet-5"]).toBeCloseTo(costUsd("claude-sonnet-5", d.usageByModel["claude-sonnet-5"]!), 12);
    const a1 = flat(d.tree).find((n) => n.key === "a1")!;
    expect(a1.costUsd).toBeCloseTo(costUsd("claude-sonnet-5", a1.usage), 12);
    expect(d.costUsd).toBeGreaterThan(0);
  });

  it("summarises the machine for today (server-local day)", () => {
    const m = radar.machine();
    expect(localDay(T_NOW)).toBe(localDay(T_LAST));
    const all = radar.listSessions();
    expect(m.liveSessions).toBe(1);
    expect(m.outputToday).toBe(all.reduce((c, s) => c + s.usage.output, 0));
    expect(m.costToday).toBeCloseTo(all.reduce((c, s) => c + s.costUsd, 0), 12);
    expect(m.runningAgents).toBe(2); // busy main + a2
    expect(m.finishedToday).toBeGreaterThanOrEqual(1);
  });
});

describe("event paging", () => {
  it("pages backwards with `before` without gaps or duplicates", async () => {
    const all = (await radar.readEvents(S1, "main", { tail: 1000 }))!;
    const last = (await radar.readEvents(S1, "main", { tail: 2 }))!;
    expect(last.start).toBeGreaterThan(0);
    const older = (await radar.readEvents(S1, "main", { tail: 1000, before: last.start }))!;
    expect(older.start).toBe(0);
    expect(older.truncated).toBe(false);
    expect([...older.events, ...last.events].map((e) => e.id)).toEqual(all.events.map((e) => e.id));
  });
});
