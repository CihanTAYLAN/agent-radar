import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BREW_CODEX, BUNDLED_CODEX, DEFAULT_MODEL, codexArgv, createCodexBackend, parseCodexJsonl, resolveCodexBin, type Runner } from "../src/summarizer/codex.js";
import { PROMPT_MAX, TopicSummarizer, buildPrompt, createSummarizer, topicHash, type SummaryBackend } from "../src/summarizer/index.js";
import type { Topic } from "../src/topics.js";

const topic = (o: Partial<Topic> = {}): Topic => ({
  id: "t1",
  kind: "ticket",
  key: "PROJ-1",
  title: "IMAP slice",
  project: "acme-app",
  providers: ["claude-code"],
  counts: { running: 1, done: 1, failed: 0, total: 2 },
  firstAt: 1,
  lastAt: 1_000_000,
  costUsd: 1,
  costPartial: false,
  modules: ["apps/api/src/modules/email"],
  recent: ["Komut çalıştırıyor gh pr checks 4121"],
  summary: "",
  agents: [
    { sessionId: "s", sessionName: "S", key: "main", label: "Ana ajan", provider: "claude-code", state: "running", isMain: true, lastActivityAt: 1 },
    { sessionId: "s", sessionName: "S", key: "a1", label: "IMAP work", provider: "claude-code", state: "done", isMain: false, lastActivityAt: 1 },
  ],
  ...o,
});

const okBackend = (text = "IMAP dilimi üzerinde çalışılıyor.") => {
  const summarize = vi.fn(async (_p: string) => text);
  const backend: SummaryBackend = { id: "codex", label: "Codex", model: "gpt-6-luna", disclosure: "d", summarize };
  return { backend, summarize };
};

describe("codex backend", () => {
  it("resolves the binary: env, bundled app, Homebrew", () => {
    const all = (p: string) => [BUNDLED_CODEX, BREW_CODEX, "/opt/mine"].includes(p);
    expect(resolveCodexBin({ AGENT_RADAR_CODEX_BIN: "/opt/mine" }, all, "darwin")).toBe("/opt/mine");
    expect(resolveCodexBin({ AGENT_RADAR_CODEX_BIN: "/nope" }, all, "darwin")).toBe(BUNDLED_CODEX);
    expect(resolveCodexBin({}, (p) => p === BREW_CODEX, "darwin")).toBe(BREW_CODEX);
    expect(resolveCodexBin({}, () => false, "darwin")).toBeUndefined();
  });

  it("argv contract: ephemeral, read-only sandbox, ignore-user-config, never dangerous flags", () => {
    const argv = codexArgv("gpt-6-luna", "/tmp/x", "özetle");
    expect(argv).toEqual(["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-C", "/tmp/x", "-m", "gpt-6-luna", "--json", "özetle"]);
    expect(argv.some((a) => a.startsWith("--dangerously"))).toBe(false);
    expect(argv.some((a) => /bypass|full-access|danger/i.test(a))).toBe(false);
    expect(argv.at(-1)).toBe("özetle");
  });

  it("parses JSONL: final message, usage, errors; ignores noise", () => {
    const out = parseCodexJsonl(
      [
        "WARN mcp auth",
        JSON.stringify({ type: "thread.started", thread_id: "x" }),
        JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "hmm" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Özet metni." } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 17000, cached_input_tokens: 16000, output_tokens: 50 } }),
        "{broken",
      ].join("\n"),
    );
    expect(out).toEqual({ text: "Özet metni.", usage: { input: 17000, output: 50, cached: 16000 } });
    expect(parseCodexJsonl(JSON.stringify({ type: "item.completed", item: { type: "message", text: "M" } })).text).toBe("M");
    expect(parseCodexJsonl(JSON.stringify({ type: "error", message: "not supported" })).error).toBe("not supported");
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })).error).toBe("boom");
  });

  it("runs the fixed argv with the model from env, creating the scratch dir once", async () => {
    const run = vi.fn<Runner>(async () => ({ stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), code: 0, timedOut: false }));
    const scratch = vi.fn(() => "/tmp/scratch-1");
    const { backend } = createCodexBackend({ env: { AGENT_RADAR_SUMMARIZER_MODEL: "gpt-x" }, run, exists: (p) => p === BREW_CODEX, platform: "darwin", scratch });
    expect(backend?.model).toBe("gpt-x");
    expect(await backend?.summarize("p1")).toBe("ok");
    await backend?.summarize("p2");
    expect(scratch).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(BREW_CODEX);
    expect(run.mock.calls[0]?.[1]).toEqual(codexArgv("gpt-x", "/tmp/scratch-1", "p1"));
    expect(createCodexBackend({ env: {}, run, exists: () => true, platform: "darwin", scratch }).backend?.model).toBe(DEFAULT_MODEL);
  });

  it("maps a timed-out run, an error event and an empty reply to errors", async () => {
    const mk = (r: Awaited<ReturnType<Runner>>) => createCodexBackend({ env: {}, run: async () => r, exists: () => true, platform: "darwin", scratch: () => "/tmp/s", timeoutMs: 5000 }).backend as SummaryBackend;
    await expect(mk({ stdout: "", code: null, timedOut: true }).summarize("p")).rejects.toThrow(/zaman aşımı/);
    await expect(mk({ stdout: JSON.stringify({ type: "error", message: "model not supported" }), code: 1, timedOut: false }).summarize("p")).rejects.toThrow(/not supported/);
    await expect(mk({ stdout: "", code: 0, timedOut: false }).summarize("p")).rejects.toThrow(/boş yanıt/);
  });

  it("linux: env var first, then `codex` on PATH, never the macOS locations", () => {
    const at = new Set(["/opt/mine", "/usr/local/bin/codex", "/home/u/.nvm/bin/codex", BUNDLED_CODEX, BREW_CODEX]);
    const exists = (p: string) => at.has(p);
    const env = { PATH: ["", "/usr/bin", "/home/u/.nvm/bin", "/usr/local/bin"].join(delimiter) };
    expect(resolveCodexBin({ ...env, AGENT_RADAR_CODEX_BIN: "/opt/mine" }, exists, "linux")).toBe("/opt/mine");
    expect(resolveCodexBin({ ...env, AGENT_RADAR_CODEX_BIN: "/nope" }, exists, "linux")).toBe("/home/u/.nvm/bin/codex");
    expect(resolveCodexBin(env, exists, "linux")).toBe("/home/u/.nvm/bin/codex");
    expect(resolveCodexBin({ PATH: "/usr/bin" }, (p) => p === BREW_CODEX || p === BUNDLED_CODEX, "linux")).toBeUndefined();
    expect(resolveCodexBin({}, exists, "linux")).toBeUndefined();
  });

  it("finds a real executable on PATH through fs.access (no `which`), skipping directories and non-executables", () => {
    const root = mkdtempSync(join(tmpdir(), "radar-path-"));
    try {
      const dirA = join(root, "a");
      const dirB = join(root, "b");
      mkdirSync(join(dirA, "codex"), { recursive: true }); // a directory named codex must not match
      mkdirSync(dirB);
      writeFileSync(join(dirB, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      expect(resolveCodexBin({ PATH: [dirA, dirB].join(delimiter) }, undefined, "linux")).toBe(join(dirB, "codex"));
      expect(resolveCodexBin({ PATH: dirA }, undefined, "linux")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing CLI as the reason", () => {
    const r = createCodexBackend({ env: {}, exists: () => false });
    expect(r.backend).toBeUndefined();
    expect(r.reason).toMatch(/bulunamadı/);
  });
});

describe("summarizer manager", () => {
  it("is off by default and for unknown names; never calls anything", () => {
    const s = createSummarizer({});
    expect(s.status()).toMatchObject({ enabled: false, callsLastHour: 0, maxPerHour: 20 });
    s.offer(topic());
    expect(s.get("t1")).toBeUndefined();
    expect(createSummarizer({ AGENT_RADAR_SUMMARIZER: "gpt" }).status().reason).toMatch(/bilinmeyen/);
    expect(createSummarizer({ AGENT_RADAR_SUMMARIZER: "codex", AGENT_RADAR_SUMMARIZER_MAX_PER_HOUR: "5" }, { exists: () => false }).status()).toMatchObject({ enabled: false, maxPerHour: 5 });
  });

  it("is on with AGENT_RADAR_SUMMARIZER=codex and discloses where data goes", () => {
    const s = createSummarizer({ AGENT_RADAR_SUMMARIZER: "codex", PATH: "/usr/bin" }, { exists: () => true, run: async () => ({ stdout: "", code: 0, timedOut: false }) });
    expect(s.status()).toMatchObject({ enabled: true, backend: "codex", model: "gpt-6-luna" });
    expect(s.status().disclosure).toContain("OpenAI");
  });

  it("summarizes, caches by facts hash, and fires onUpdate", async () => {
    const { backend, summarize } = okBackend();
    const onUpdate = vi.fn();
    let now = 5_000_000;
    const s = new TopicSummarizer({ backend, now: () => now, onUpdate });
    const t = topic();
    s.offer(t);
    await s.idle();
    expect(s.get("t1")?.text).toBe("IMAP dilimi üzerinde çalışılıyor.");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // unchanged facts: served from cache, no second call
    now += 20 * 60_000;
    s.offer(t);
    await s.idle();
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(s.status()).toMatchObject({ callsLastHour: 1, lastOkAt: now - 20 * 60_000 });
  });

  it("debounces the same topic for 10 minutes even when facts change", async () => {
    const { backend, summarize } = okBackend();
    let now = 5_000_000;
    const s = new TopicSummarizer({ backend, now: () => now });
    s.offer(topic({ lastAt: now }));
    await s.idle();
    now += 60_000;
    s.offer(topic({ lastAt: now }));
    await s.idle();
    expect(summarize).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    s.offer(topic({ lastAt: now }));
    await s.idle();
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("caps calls per hour and frees the budget after an hour", async () => {
    const { backend, summarize } = okBackend();
    let now = 5_000_000;
    const s = new TopicSummarizer({ backend, now: () => now, maxPerHour: 2, debounceMs: 0 });
    for (const id of ["a", "b", "c"]) {
      s.offer(topic({ id, lastAt: now }));
      await s.idle();
    }
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(s.get("c")).toBeUndefined();
    now += 3600_001;
    s.offer(topic({ id: "c", lastAt: now }));
    await s.idle();
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it("runs one call at a time (concurrency 1)", async () => {
    let active = 0;
    let peak = 0;
    const backend: SummaryBackend = {
      id: "codex",
      label: "Codex",
      model: "m",
      disclosure: "d",
      summarize: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return "ok";
      },
    };
    const s = new TopicSummarizer({ backend, now: () => 5_000_000, debounceMs: 0 });
    for (const id of ["a", "b", "c"]) s.offer(topic({ id, lastAt: 5_000_000 }));
    await s.idle();
    expect(peak).toBe(1);
    expect(["a", "b", "c"].every((id) => s.get(id))).toBe(true);
  });

  it("falls back silently on failure/timeout and records the last error", async () => {
    const backend: SummaryBackend = { id: "codex", label: "Codex", model: "m", disclosure: "d", summarize: async () => Promise.reject(new Error("zaman aşımı (60 sn)")) };
    const s = new TopicSummarizer({ backend, now: () => 5_000_000 });
    s.offer(topic());
    await s.idle();
    expect(s.get("t1")).toBeUndefined();
    expect(s.status()).toMatchObject({ enabled: true, lastError: "zaman aşımı (60 sn)", callsLastHour: 1 });
  });

  it("only summarizes running or recently active topics, never 'Diğer'", async () => {
    const { backend, summarize } = okBackend();
    const now = 50_000_000;
    const s = new TopicSummarizer({ backend, now: () => now });
    s.offer(topic({ id: "old", lastAt: now - 3 * 3600_000, counts: { running: 0, done: 2, failed: 0, total: 2 } }));
    s.offer(topic({ id: "oth", kind: "other", lastAt: now }));
    await s.idle();
    expect(summarize).not.toHaveBeenCalled();
    s.offer(topic({ id: "live", lastAt: now - 3 * 3600_000 }));
    await s.idle();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("masks secrets in the prompt and keeps it within 2000 chars", () => {
    const t = topic({ recent: ["Komut çalıştırıyor export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"], agents: Array.from({ length: 30 }, (_, i) => ({ sessionId: "s", sessionName: "S", key: `k${i}`, label: "x".repeat(200), provider: "claude-code", state: "done" as const, isMain: false, lastActivityAt: 1 })) });
    const p = buildPrompt(t);
    expect(p).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(p).toContain("Emir kipi kullanma");
    expect(topicHash(topic())).not.toBe(topicHash(topic({ lastAt: 2 })));
  });
});
