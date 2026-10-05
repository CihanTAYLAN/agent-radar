import { describe, expect, it } from "vitest";
import {
  encodeCwd,
  entryInfo,
  extractAgentLinks,
  extractSpawns,
  extractTaskNotifications,
  isRegistryFileName,
  notificationOutcome,
  splitCdPrefix,
  parseAgentMeta,
  parseAgentMetaName,
  parseAgentTranscriptName,
  parseCustomTitleFile,
  parseLine,
  parseRegistryFile,
  sessionMetaFromEntry,
  summarizeToolInput,
  toEvents,
  describeToolUses,
  describeAction,
  shortPath,
  toolDetail,
  toolUseTime,
  type RawEntry,
} from "../src/providers/claude-code/format.js";

const line = (o: unknown): RawEntry => {
  const e = parseLine(JSON.stringify(o));
  if (!e) throw new Error("fixture line did not parse");
  return e;
};

describe("registry + meta parsing", () => {
  it("parses a registry file and keeps optional fields", () => {
    const e = parseRegistryFile(JSON.stringify({ pid: 42, sessionId: "abc", cwd: "/x", startedAt: 5, status: "busy", name: "N", extra: 1 }));
    expect(e).toEqual({ pid: 42, sessionId: "abc", cwd: "/x", startedAt: 5, status: "busy", name: "N" });
  });
  it("rejects garbage and entries without pid/sessionId", () => {
    expect(parseRegistryFile("{ nope")).toBeNull();
    expect(parseRegistryFile("[]")).toBeNull();
    expect(parseRegistryFile(JSON.stringify({ pid: 1 }))).toBeNull();
    expect(parseRegistryFile(JSON.stringify({ sessionId: "s" }))).toBeNull();
  });
  it("only accepts <pid>.json, never key files", () => {
    expect(isRegistryFileName("8816.json")).toBe(true);
    expect(isRegistryFileName("8816.63a964a132fb4d1c.key")).toBe(false);
    expect(isRegistryFileName("notes.json")).toBe(false);
  });
  it("parses agent meta leniently", () => {
    expect(parseAgentMeta('{"agentType":"vekil","description":"d","toolUseId":"toolu_1","spawnDepth":2,"requestShape":"background","unknown":true}')).toEqual({
      agentType: "vekil",
      description: "d",
      toolUseId: "toolu_1",
      spawnDepth: 2,
      requestShape: "background",
    });
    expect(parseAgentMeta("{}")).toEqual({});
    expect(parseAgentMeta("nope")).toBeNull();
  });
  it("parses agent file names", () => {
    expect(parseAgentTranscriptName("agent-a1b2.jsonl")).toBe("a1b2");
    expect(parseAgentTranscriptName("agent-a1b2.meta.json")).toBeNull();
    expect(parseAgentMetaName("agent-a1b2.meta.json")).toBe("a1b2");
    expect(parseAgentTranscriptName("../evil.jsonl")).toBeNull();
  });
  it("parses custom-title.json", () => {
    expect(parseCustomTitleFile('{"customTitle":"Hi"}')).toBe("Hi");
    expect(parseCustomTitleFile("bad")).toBeUndefined();
  });
  it("encodes cwd like Claude Code does", () => {
    expect(encodeCwd("/Users/x/workspace/a.b_c")).toBe("-Users-x-workspace-a-b-c");
    expect(encodeCwd("/a/.claude/worktrees/x")).toBe("-a--claude-worktrees-x");
  });
});

describe("parseLine", () => {
  it("never throws and skips blank / partial / non-object lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine('{"type":"assistant","message":')).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();
    expect(parseLine("plain text")).toBeNull();
    expect(parseLine('{"type":"x"}')).toEqual({ type: "x" });
  });
  it("unknown entry types yield info without message fields", () => {
    const info = entryInfo(line({ type: "future-thing", timestamp: "t" }));
    expect(info).toEqual({ type: "future-thing", timestamp: "t" });
  });
});

describe("entryInfo", () => {
  it("extracts usage, model and stop reason from an assistant entry", () => {
    const info = entryInfo(
      line({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00Z",
        cwd: "/w",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [],
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        },
      }),
    );
    expect(info.messageId).toBe("msg_1");
    expect(info.model).toBe("claude-opus-5-5");
    expect(info.stopReason).toBe("end_turn");
    expect(info.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreate: 4 });
  });
  it("carries the 1h share of the cache_creation split (absent when there is none)", () => {
    const mk = (cc: unknown) => entryInfo(line({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_creation: cc } } }));
    expect(mk({ ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 }).usage).toEqual({ input: 1, output: 0, cacheRead: 0, cacheCreate: 10, cacheCreate1h: 6 });
    expect(mk({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }).usage).toEqual({ input: 1, output: 0, cacheRead: 0, cacheCreate: 10 });
    expect(mk(undefined).usage).toEqual({ input: 1, output: 0, cacheRead: 0, cacheCreate: 10 });
  });
  it("ignores the synthetic model and tolerates missing usage fields", () => {
    const info = entryInfo(line({ type: "assistant", message: { role: "assistant", model: "<synthetic>", usage: { input_tokens: 5 } } }));
    expect(info.model).toBeUndefined();
    expect(info.usage).toEqual({ input: 5, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});

describe("spawns, links, notifications", () => {
  it("extracts Agent/Task tool_use blocks only", () => {
    const e = line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Do X", subagent_type: "vekil", model: "sonnet", run_in_background: true, isolation: "worktree" } },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_3", name: "Task", input: { description: "old name" } },
        ],
      },
    });
    const sp = extractSpawns(e);
    expect(sp.map((s) => s.toolUseId)).toEqual(["toolu_1", "toolu_3"]);
    expect(sp[0]).toEqual({ toolUseId: "toolu_1", description: "Do X", subagentType: "vekil", model: "sonnet", background: true, isolation: "worktree" });
  });
  it("links a tool_use id to an agent id via toolUseResult", () => {
    const e = line({ type: "user", toolUseResult: { agentId: "a9" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "ok" }] } });
    expect(extractAgentLinks(e)).toEqual([{ toolUseId: "toolu_9", agentId: "a9" }]);
    expect(extractAgentLinks(line({ type: "user", message: { role: "user", content: "hi" } }))).toEqual([]);
  });
  it("maps notification statuses to outcomes (failed is not the same as stopped by the user)", () => {
    expect(notificationOutcome("completed")).toBe("done");
    expect(notificationOutcome("failed")).toBe("failed");
    expect(notificationOutcome("error")).toBe("failed");
    expect(notificationOutcome("killed")).toBe("stopped");
    expect(notificationOutcome("stopped")).toBe("stopped");
    expect(notificationOutcome("cancelled")).toBe("stopped");
    expect(notificationOutcome(" Killed ")).toBe("stopped");
    expect(notificationOutcome("running")).toBeUndefined();
    expect(notificationOutcome("")).toBeUndefined();
    expect(notificationOutcome(undefined)).toBeUndefined();
  });

  it("parses task-notifications from user and queue-operation entries", () => {
    const text = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>failed</status>\n<summary>Agent \"x\" failed</summary>\n</task-notification>";
    const u = extractTaskNotifications(line({ type: "user", message: { role: "user", content: text } }));
    expect(u).toEqual([{ taskId: "a1", toolUseId: "toolu_1", status: "failed", summary: 'Agent "x" failed' }]);
    const q = extractTaskNotifications(line({ type: "queue-operation", operation: "enqueue", content: text }));
    expect(q[0]?.status).toBe("failed");
    expect(extractTaskNotifications(line({ type: "queue-operation", operation: "dequeue", content: text }))).toEqual([]);
  });
  it("reads session-level meta lines", () => {
    expect(sessionMetaFromEntry(line({ type: "custom-title", customTitle: "T" }))).toEqual({ customTitle: "T" });
    expect(sessionMetaFromEntry(line({ type: "agent-name", agentName: "A" }))).toEqual({ agentName: "A" });
    expect(sessionMetaFromEntry(line({ type: "assistant" }))).toEqual({});
  });
  it("counts tool uses and describes the last", () => {
    const e = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: { file_path: "/a" } }, { type: "tool_use", id: "2", name: "Bash", input: { command: "npm  test" } }] } });
    expect(describeToolUses(e)).toEqual({ count: 2, last: "Bash: npm test", action: { tool: "Bash", kind: "bash", target: "npm test" } });
  });
});

describe("toEvents", () => {
  it("emits text and tool_use events, with one-line masked summaries", () => {
    const evs = toEvents(
      line({
        type: "assistant",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "abc" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' x\n  y" } },
          ],
        },
      }),
    );
    expect(evs.map((e) => e.kind)).toEqual(["assistant", "tool_use"]);
    expect(evs[0]).toMatchObject({ id: "u1:1", text: "hello", ts: "2026-01-01T00:00:00Z" });
    expect(evs[1]?.tool).toBe("Bash");
    expect(evs[1]?.text).not.toContain("abcdefghijklmnop");
    expect(evs[1]?.text).not.toContain("\n");
  });

  it("truncates tool results to 2 KB and masks secrets inside them", () => {
    const big = "line\n".repeat(2000) + " API_KEY=supersecretvalue1";
    const evs = toEvents(line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }] } }));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.kind).toBe("tool_result");
    expect(evs[0]?.text.length).toBeLessThan(2048 + 60);
    expect(evs[0]?.text).toContain("truncated");
    const small = toEvents(line({ type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "PASSWORD=hunter2" }, { type: "image" }], is_error: true }] } }));
    expect(small[0]?.text).toBe("PASSWORD=[REDACTED]\n[image]");
    expect(small[0]?.isError).toBe(true);
  });

  it("shows task notifications compactly and hides system reminders", () => {
    const n = toEvents(line({ type: "user", uuid: "u4", message: { role: "user", content: "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" } }));
    expect(n).toEqual([{ id: "u4:0", kind: "notification", text: "task a1 completed - done" }]);
    expect(toEvents(line({ type: "user", uuid: "u5", message: { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] } }))).toEqual([]);
  });

  it("ignores non-message entries", () => {
    expect(toEvents(line({ type: "attachment", attachment: {} }))).toEqual([]);
    expect(toEvents(line({ type: "future-thing" }))).toEqual([]);
  });
});

describe("summarizeToolInput", () => {
  it("picks the meaningful key per tool and falls back sensibly", () => {
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts", limit: 3 })).toBe("/a/b.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "." })).toBe("foo");
    expect(summarizeToolInput("mcp__x__do", { thing: "value" })).toBe("value");
    expect(summarizeToolInput("mcp__x__do", { n: 1 })).toBe('{"n":1}');
    expect(summarizeToolInput("Bash", { command: "x".repeat(500) }, 50).length).toBeLessThan(120);
  });
});

describe("current-action summarizer", () => {
  it("classifies common tools and picks a readable target", () => {
    expect(describeAction("Bash", { command: "npm   test\n  --run", description: "run tests" })).toEqual({ tool: "Bash", kind: "bash", target: "npm test --run" });
    expect(describeAction("Edit", { file_path: "/Users/x/proj/src/deep/foo.ts", old_string: "a", new_string: "b" })).toEqual({ tool: "Edit", kind: "edit", target: "…/src/deep/foo.ts" });
    expect(describeAction("Write", { file_path: "a.ts", content: "x" })).toMatchObject({ kind: "write", target: "a.ts" });
    expect(describeAction("Read", { file_path: "/etc/hosts" })).toMatchObject({ kind: "read", target: "/etc/hosts" });
    expect(describeAction("Grep", { pattern: "TODO", path: "/repo/src/lib" })).toMatchObject({ kind: "search", target: "TODO · …/src/lib" });
    expect(describeAction("Glob", { pattern: "**/*.ts" })).toMatchObject({ kind: "search", target: "**/*.ts" });
    expect(describeAction("Agent", { description: "Fix tests", prompt: "long" })).toMatchObject({ kind: "agent", target: "Fix tests" });
    expect(describeAction("WebFetch", { url: "https://example.com" })).toMatchObject({ kind: "web", target: "https://example.com" });
    expect(describeAction("mcp__atlassian__getJiraIssue", { issueIdOrKey: "PROJ-1" })).toMatchObject({ kind: "mcp", target: "atlassian · getJiraIssue: PROJ-1" });
    expect(describeAction("SomethingNew", { foo: "bar" })).toMatchObject({ kind: "other", target: "bar" });
    expect(describeAction("Bash", null)).toMatchObject({ kind: "bash", target: "" });
    expect(describeAction("Bash", { command: "cd /very/long/worktree/path && npm test" })).toEqual({ tool: "Bash", kind: "bash", target: "npm test", dir: "/very/long/worktree/path" });
    expect(describeAction("Bash", { command: `cd "/a b" ; ls` })).toMatchObject({ target: "ls", dir: "/a b" });
    expect(describeAction("Bash", { command: "cd /only/dir" })).toEqual({ tool: "Bash", kind: "bash", target: "cd /only/dir" });
  });
  it("splits leading cd prefixes", () => {
    expect(splitCdPrefix("cd /a && cd b && make")).toEqual({ dir: "b", rest: "make" });
    expect(splitCdPrefix("make && cd /x")).toEqual({ rest: "make && cd /x" });
  });
  it("masks secrets and truncates long targets", () => {
    const a = describeAction("Bash", { command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" ${"x".repeat(800)}` });
    expect(a.target).not.toContain("abcdefghijklmnop");
    expect(a.target.length).toBeLessThanOrEqual(400); // commands: 400, other targets: 160
    expect(describeAction("Grep", { pattern: "p".repeat(400) }).target.length).toBeLessThanOrEqual(160);
    expect(a.target.endsWith("…")).toBe(true);
    expect(a.target).not.toContain("truncated");
    expect(a.target).not.toContain("\n");
  });
  it("shortens paths to the last segments", () => {
    expect(shortPath("/a/b/c/d/e.ts")).toBe("…/c/d/e.ts");
    expect(shortPath("src/x.ts")).toBe("src/x.ts");
  });
});

describe("tool detail + tool-use times", () => {
  it("keeps selected fields, masked", () => {
    expect(toolDetail("Edit", { file_path: "/a.ts", old_string: "x = 1", new_string: "API_KEY=sk-abcdefghijklmnopqrstuvwxyz", junk: 1 })).toEqual({
      file_path: "/a.ts",
      old_string: "x = 1",
      new_string: "API_KEY=[REDACTED]",
    });
    expect(toolDetail("MultiEdit", { file_path: "/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })).toEqual({
      file_path: "/a.ts",
      edits: "2",
      old_string: "a",
      new_string: "b",
    });
    expect(toolDetail("Bash", { command: "ls", run_in_background: true })).toEqual({ command: "ls", run_in_background: "true" });
    expect(toolDetail("Unknown", { a: "b" })).toBeUndefined();
    expect(toolDetail("Bash", "nope")).toBeUndefined();
  });
  it("attaches detail to tool_use events", () => {
    const evs = toEvents(line({ type: "assistant", uuid: "u", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test" } }] } }));
    expect(evs[0]?.detail).toEqual({ command: "npm test" });
  });
  it("reports the time of assistant lines that call tools", () => {
    const ts = "2026-01-01T10:00:00.000Z";
    expect(toolUseTime(line({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: "Bash", id: "1" }] } }))).toBe(Date.parse(ts));
    expect(toolUseTime(line({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text: "hi" }] } }))).toBeUndefined();
    expect(toolUseTime(line({ type: "user", timestamp: ts, message: { content: [{ type: "tool_use", name: "Bash", id: "1" }] } }))).toBeUndefined();
    expect(toolUseTime(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "1" }] } }))).toBeUndefined();
  });
});
