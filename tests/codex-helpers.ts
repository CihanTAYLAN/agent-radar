/**
 * Synthetic Codex home for tests: rollouts + a tiny state_5.sqlite built with node:sqlite in a temp
 * dir. Every value here is made up; nothing is copied from real data.
 */
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqlite } from "../src/providers/sqlite.js";

export const ROOT = "0190aaaa-0000-7000-8000-000000000001";
export const CHILD = "0190aaaa-0000-7000-8000-000000000002";
export const GRAND = "0190aaaa-0000-7000-8000-000000000003";
export const OLD = "0190aaaa-0000-7000-8000-000000000004";
export const CLI = "0190aaaa-0000-7000-8000-000000000005";
export const SNEAKY = "0190aaaa-0000-7000-8000-000000000006";

/** Fake clock: rollouts end at T_END; "now" is 30 s later. */
export const T_END = Date.parse("2026-03-10T10:10:00.000Z");
export const C_NOW = T_END + 30_000;

export const SECRET = "sk-proj-THISISAFAKEKEYFORTESTS1234567890";
export const AUTH_SENTINEL = "AUTH-SENTINEL-DO-NOT-READ";

const iso = (ms: number) => new Date(ms).toISOString();
const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: 1,
  total_tokens: input + output,
});

type L = Record<string, unknown>;
let ord = 0;
const line = (ms: number, type: string, payload: L, extra: L = {}): L => ({ timestamp: iso(ms), ordinal: ord++, type, payload, ...extra });

function meta(id: string, ms: number, cwd: string, source: unknown, parent?: string, nick?: string, path?: string): L {
  return line(ms, "session_meta", {
    session_id: ROOT,
    id,
    parent_thread_id: parent ?? null,
    timestamp: iso(ms),
    cwd,
    originator: "Codex Desktop",
    cli_version: "0.99.0-test",
    source,
    thread_source: parent ? "subagent" : "user",
    agent_nickname: nick ?? null,
    agent_path: path ?? null,
    model_provider: "openai",
    base_instructions: "BASE-INSTRUCTIONS-NEVER-SHOWN ".repeat(20),
  });
}

function rootLines(): L[] {
  const t = T_END - 9 * 60_000;
  ord = 0;
  return [
    meta(ROOT, t, `/tmp/cx-demo/proj`, "vscode"),
    line(t + 1, "event_msg", { type: "task_started", turn_id: "turn-1", model_context_window: 1000 }),
    line(t + 2, "response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "DEVELOPER-INSTRUCTIONS-HIDDEN" }] }),
    line(t + 3, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>ctx</environment_context>" }, { type: "input_text", text: "Fix the build please" }] }),
    line(t + 4, "turn_context", { turn_id: "turn-1", cwd: "/tmp/cx-demo/proj", model: "gpt-5", approval_policy: "never", effort: "high" }),
    line(t + 5, "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking about the build" }], encrypted_content: "ENCRYPTED-REASONING-NEVER-SHOWN" }),
    line(t + 6, "response_item", {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_exec1",
      name: "exec",
      input: `const r = await tools.exec_command({cmd:"cd /tmp/cx-demo/proj && OPENAI_API_KEY=${SECRET} npm test","workdir":"/tmp/cx-demo/proj"}); text(r)`,
    }),
    line(t + 7, "token_usage_record", { thread_id: ROOT, turn_id: "turn-1", response_id: "resp_1", usage: usage(1000, 600, 100) }),
    // Same response id again: must not be counted twice.
    line(t + 8, "token_usage_record", { thread_id: ROOT, turn_id: "turn-1", response_id: "resp_1", usage: usage(1000, 600, 100) }),
    line(t + 9, "event_msg", { type: "token_count", info: { total_token_usage: usage(1000, 600, 100), last_token_usage: usage(1000, 600, 100) } }),
    line(t + 10, "response_item", { type: "custom_tool_call_output", call_id: "call_exec1", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: "3 passing" }] }),
    line(t + 11, "response_item", { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "call_spawn1", arguments: JSON.stringify({ task_name: "review_task", model: "gpt-5-mini", message: "gAAAAopaque" }) }),
    line(t + 12, "response_item", { type: "function_call_output", call_id: "call_spawn1", output: "" }),
    line(t + 13, "response_item", {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_patch1",
      name: "exec",
      input: 'const patch = "*** Begin Patch\\n*** Update File: /tmp/cx-demo/proj/src/a.ts\\n@@\\n-const a = 1;\\n+const a = 2;\\n*** End Patch"; await tools.apply_patch(patch);',
    }),
    line(t + 14, "response_item", { type: "custom_tool_call_output", call_id: "call_patch1", output: [{ type: "input_text", text: "Success. Updated the following files:\nM /tmp/cx-demo/proj/src/a.ts" }] }),
    line(t + 15, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done: tests pass." }] }),
    line(t + 16, "token_usage_record", { thread_id: ROOT, turn_id: "turn-1", response_id: "resp_2", usage: usage(2000, 1500, 50) }),
    line(t + 17, "event_msg", { type: "task_complete", turn_id: "turn-1", duration_ms: 65_000 }),
    // Second turn, still open, currently running a command.
    line(T_END - 60_000, "event_msg", { type: "task_started", turn_id: "turn-2" }),
    line(T_END - 50_000, "response_item", { type: "function_call", name: "shell", call_id: "call_sh2", arguments: JSON.stringify({ command: ["bash", "-lc", "cargo build --release"], workdir: "/tmp/cx-demo/proj" }) }),
    line(T_END, "world_state", { full: true, state: { big: "x".repeat(300 * 1024) } }),
  ];
}

function childLines(): L[] {
  const t = T_END - 8 * 60_000;
  ord = 0;
  const src = { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: "/root/review_task", agent_nickname: "Hopper", agent_role: null } } };
  return [
    meta(CHILD, t, "/tmp/cx-demo/proj", src, ROOT, "Hopper", "/root/review_task"),
    line(t + 1, "event_msg", { type: "task_started", turn_id: "c-1" }),
    line(t + 2, "turn_context", { turn_id: "c-1", cwd: "/tmp/cx-demo/proj", model: "gpt-5-mini" }),
    line(t + 3, "response_item", { type: "agent_message", author: "/root", recipient: "/root/review_task", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nReview src/a.ts" }, { type: "encrypted_content", encrypted_content: "ENCRYPTED-AGENT-MSG" }] }),
    line(t + 4, "token_usage_record", { thread_id: CHILD, turn_id: "c-1", response_id: "resp_c1", usage: usage(500, 0, 40) }),
    line(t + 5, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looks fine." }] }),
    line(t + 6, "event_msg", { type: "task_complete", turn_id: "c-1", duration_ms: 5000 }),
  ];
}

function grandLines(): L[] {
  const t = T_END - 7 * 60_000;
  ord = 0;
  const src = { subagent: { thread_spawn: { parent_thread_id: CHILD, depth: 2, agent_path: "/root/review_task/deep_check", agent_nickname: "Lovelace" } } };
  return [
    meta(GRAND, t, "/tmp/cx-demo/proj", src, CHILD, "Lovelace", "/root/review_task/deep_check"),
    line(t + 1, "event_msg", { type: "task_started", turn_id: "g-1" }),
    line(t + 2, "turn_context", { turn_id: "g-1", model: "gpt-9-imaginary" }),
    line(t + 3, "token_usage_record", { thread_id: GRAND, turn_id: "g-1", response_id: "resp_g1", usage: usage(300, 100, 30) }),
    line(t + 4, "event_msg", { type: "turn_aborted", turn_id: "g-1", reason: "interrupted" }),
  ];
}

function cliLines(): L[] {
  const t = T_END - 5 * 3600_000;
  ord = 0;
  return [
    meta(CLI, t, "/tmp/cx-cli", "cli"),
    line(t + 1, "event_msg", { type: "task_started", turn_id: "x-1" }),
    line(t + 2, "turn_context", { turn_id: "x-1", model: "o3" }),
    // Older rollouts without token_usage_record: token_count totals are used instead.
    line(t + 3, "event_msg", { type: "token_count", info: { total_token_usage: usage(100, 0, 10) } }),
    line(t + 4, "event_msg", { type: "token_count", info: { total_token_usage: usage(100, 0, 10) } }),
    line(t + 5, "event_msg", { type: "token_count", info: { total_token_usage: usage(250, 50, 30) } }),
    line(t + 6, "event_msg", { type: "task_complete", turn_id: "x-1" }),
  ];
}

const jsonl = (ls: L[]) => ls.map((l) => JSON.stringify(l)).join("\n") + "\n";

export interface CodexHome {
  home: string;
  files: Record<string, string>;
}

/** Builds the synthetic home. `withDb: false` leaves out the SQLite index (fallback mode). */
export async function makeCodexHome(opts: { withDb?: boolean } = {}): Promise<CodexHome> {
  const home = await mkdtemp(join(tmpdir(), "radar-codex-"));
  const day = join(home, "sessions", "2026", "03", "10");
  const oldDay = join(home, "sessions", "2026", "02", "01");
  await mkdir(day, { recursive: true });
  await mkdir(oldDay, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const files: Record<string, string> = {
    [ROOT]: join(day, `rollout-2026-03-10T10-01-00-${ROOT}.jsonl`),
    [CHILD]: join(day, `rollout-2026-03-10T10-02-00-${CHILD}.jsonl`),
    [GRAND]: join(day, `rollout-2026-03-10T10-03-00-${GRAND}.jsonl`),
    [CLI]: join(day, `rollout-2026-03-10T05-00-00-${CLI}.jsonl`),
    [OLD]: join(oldDay, `rollout-2026-02-01T09-00-00-${OLD}.jsonl`),
  };
  await writeFile(files[ROOT] as string, jsonl(rootLines()));
  await writeFile(files[CHILD] as string, jsonl(childLines()));
  await writeFile(files[GRAND] as string, jsonl(grandLines()));
  await writeFile(files[CLI] as string, jsonl(cliLines()));
  ord = 0;
  await writeFile(files[OLD] as string, jsonl([meta(OLD, Date.parse("2026-02-01T09:00:00Z"), "/tmp/cx-old", "cli")]));
  // Secrets that must never be read.
  await writeFile(join(home, "auth.json"), JSON.stringify({ token: AUTH_SENTINEL }));
  await writeFile(join(home, "config.toml"), `api_key = "${AUTH_SENTINEL}"\n`);

  const set = async (id: string, ms: number) => utimes(files[id] as string, new Date(ms), new Date(ms));
  await set(ROOT, T_END); // 30 s old: running (open turn)
  await set(CHILD, T_END - 8 * 60_000 + 10); // done
  await set(GRAND, T_END - 7 * 60_000 + 10); // aborted -> stopped
  await set(CLI, T_END - 5 * 3600_000 + 10); // done, token_count only
  await set(OLD, Date.parse("2026-02-01T09:00:00Z")); // outside the window

  if (opts.withDb !== false) {
    const mod = await loadSqlite();
    if (!mod) throw new Error("node:sqlite unavailable in tests");
    const db = new mod.DatabaseSync(join(home, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT, agent_nickname TEXT, agent_role TEXT, model TEXT, reasoning_effort TEXT,
      agent_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, originator TEXT, cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '')`);
    db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
    const ins = db.prepare(
      "INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, git_branch, agent_nickname, model, agent_path, created_at_ms, updated_at_ms, thread_source, originator, cli_version) VALUES (?, ?, ?, ?, ?, 'openai', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'Codex Desktop', '0.99.0-test')",
    );
    const row = (id: string, path: string, created: number, updated: number, source: string, cwd: string, title: string, branch: string | null, nick: string | null, model: string, agentPath: string | null, ts: string) =>
      ins.run(id, path, Math.floor(created / 1000), Math.floor(updated / 1000), source, cwd, title, branch, nick, model, agentPath, created, updated, ts);
    row(ROOT, files[ROOT] as string, T_END - 9 * 60_000, T_END, "vscode", "/tmp/cx-demo/proj", "Fix&#x20;the\n\nbuild", "main", null, "gpt-5", null, "user");
    const sub = (p: string, d: number, path: string, nick: string) => JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: p, depth: d, agent_path: path, agent_nickname: nick, agent_role: null } } });
    row(CHILD, files[CHILD] as string, T_END - 8 * 60_000, T_END - 8 * 60_000, sub(ROOT, 1, "/root/review_task", "Hopper"), "/tmp/cx-demo/proj", "", null, "Hopper", "gpt-5-mini", "/root/review_task", "subagent");
    row(GRAND, files[GRAND] as string, T_END - 7 * 60_000, T_END - 7 * 60_000, sub(CHILD, 2, "/root/review_task/deep_check", "Lovelace"), "/tmp/cx-demo/proj", "", null, "Lovelace", "gpt-9-imaginary", "/root/review_task/deep_check", "subagent");
    row(CLI, files[CLI] as string, T_END - 5 * 3600_000, T_END - 5 * 3600_000, "cli", "/tmp/cx-cli", "cli run", null, null, "o3", null, "user");
    row(OLD, files[OLD] as string, Date.parse("2026-02-01T09:00:00Z"), Date.parse("2026-02-01T09:00:00Z"), "cli", "/tmp/cx-old", "old", null, null, "o3", null, "user");
    // A row whose rollout path points at a secret: must be skipped, never read.
    row(SNEAKY, join(home, "auth.json"), T_END - 60_000, T_END - 60_000, "cli", "/tmp/x", "sneaky", null, null, "o3", null, "user");
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(ROOT, CHILD);
    db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')").run(CHILD, GRAND);
    db.close();
  }
  return { home, files };
}
