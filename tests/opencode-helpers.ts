/**
 * Synthetic opencode data dir for tests: a tiny opencode.db built with node:sqlite in a temp dir, plus
 * decoy auth.json / config files. Every value is made up; nothing is copied from real data.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqlite } from "../src/providers/sqlite.js";

export const ROOT = "ses_ROOT0000000001";
export const CHILD = "ses_CHILD000000002";
export const OLD = "ses_OLD00000000003";
export const FAILED = "ses_FAIL0000000004";

export const O_NOW = Date.parse("2026-09-21T12:00:00.000Z");
export const SECRET = "sk-proj-THISISAFAKEKEYFORTESTS1234567890";
export const AUTH_SENTINEL = "AUTH-SENTINEL-DO-NOT-READ";

const SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text, title text, version text,
  time_created integer, time_updated integer, time_archived integer, agent text, model text, cost real,
  tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);
`;

type Db = InstanceType<typeof import("node:sqlite").DatabaseSync>;

interface SessionSeed {
  id: string;
  parent?: string;
  title: string;
  agent: string;
  created: number;
  updated: number;
  cost: number;
  tokens: [number, number, number, number, number];
  model?: string;
}

function addSession(db: Db, s: SessionSeed): void {
  db.prepare("INSERT INTO session VALUES (?, 'prj', ?, 'slug', ?, ?, '1.18.20', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    s.id,
    s.parent ?? null,
    "/tmp/oc-demo/proj",
    s.title,
    s.created,
    s.updated,
    s.agent,
    JSON.stringify({ id: s.model ?? "glm-4.7-free", providerID: "opencode", variant: "default" }),
    s.cost,
    ...s.tokens,
  );
}

function addMessage(db: Db, id: string, session: string, created: number, updated: number, data: Record<string, unknown>): void {
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, created, updated, JSON.stringify(data));
}

function addPart(db: Db, id: string, message: string, session: string, created: number, updated: number, data: Record<string, unknown>): void {
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(id, message, session, created, updated, JSON.stringify(data));
}

const asst = (created: number, completed: number | undefined, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  mode: "build",
  agent: "build",
  modelID: "glm-4.7-free",
  providerID: "opencode",
  time: completed === undefined ? { created } : { created, completed },
  ...extra,
});

export interface OpencodeFixture {
  dir: string;
  db: string;
}

export async function makeOpencodeHome(name = "opencode", dbName = "opencode.db"): Promise<OpencodeFixture> {
  const base = await mkdtemp(join(tmpdir(), "agent-radar-oc-"));
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ key: AUTH_SENTINEL }));
  const db = join(dir, dbName);
  const mod = await loadSqlite();
  if (!mod) throw new Error("node:sqlite unavailable");
  const d = new mod.DatabaseSync(db);
  d.exec(SCHEMA);
  const T = O_NOW;

  // ROOT: a running turn (assistant message still open), updated 10 s ago.
  addSession(d, { id: ROOT, title: "Refactor the parser", agent: "build", created: T - 20 * 60_000, updated: T - 10_000, cost: 0.25, tokens: [1000, 400, 100, 5000, 200] });
  addMessage(d, "msg_u1", ROOT, T - 20 * 60_000, T - 20 * 60_000, { role: "user", time: { created: T - 20 * 60_000 }, agent: "build", model: { providerID: "opencode", modelID: "glm-4.7-free" } });
  addPart(d, "prt_01", "msg_u1", ROOT, T - 20 * 60_000, T - 20 * 60_000, { type: "text", text: "Please refactor the parser module" });
  addPart(d, "prt_01s", "msg_u1", ROOT, T - 20 * 60_000 + 1, T - 20 * 60_000 + 1, { type: "text", text: "SYNTHETIC-SYSTEM-REMINDER", synthetic: true });
  addMessage(d, "msg_a1", ROOT, T - 19 * 60_000, T - 10_000, asst(T - 19 * 60_000, undefined));
  addPart(d, "prt_02", "msg_a1", ROOT, T - 19 * 60_000, T - 19 * 60_000 + 500, { type: "reasoning", text: "Thinking about the parser layout", time: { start: 1, end: 2 } });
  addPart(d, "prt_03", "msg_a1", ROOT, T - 18 * 60_000, T - 18 * 60_000 + 500, { type: "text", text: "I will start by reading the file.", time: { start: 1, end: 2 } });
  addPart(d, "prt_04", "msg_a1", ROOT, T - 17 * 60_000, T - 17 * 60_000 + 900, {
    type: "tool",
    tool: "read",
    callID: "call_read",
    state: { status: "completed", input: { filePath: "/tmp/oc-demo/proj/src/parser.ts" }, output: `export const KEY = "${SECRET}";`, time: { start: 1, end: 2 } },
  });
  addPart(d, "prt_05", "msg_a1", ROOT, T - 16 * 60_000, T - 16 * 60_000 + 900, {
    type: "tool",
    tool: "task",
    callID: "call_task",
    state: { status: "completed", input: { description: "Explore the tests", subagent_type: "explore", prompt: "look" }, output: "done", metadata: { sessionId: CHILD }, time: { start: 1, end: 2 } },
  });
  addPart(d, "prt_06", "msg_a1", ROOT, T - 15 * 60_000, T - 15 * 60_000 + 900, {
    type: "tool",
    tool: "bash",
    callID: "call_bad",
    state: { status: "error", input: { command: "npm run nope" }, error: "exit 1", time: { start: 1, end: 2 } },
  });
  addPart(d, "prt_07", "msg_a1", ROOT, T - 30_000, T - 10_000, {
    type: "tool",
    tool: "bash",
    callID: "call_run",
    state: { status: "running", input: { command: `cd /tmp/oc-demo/proj && npm test --token=${SECRET}`, description: "run tests" }, time: { start: 1 } },
  });
  addPart(d, "prt_08", "msg_a1", ROOT, T - 9_000, T - 9_000, { type: "text", text: "streaming, not finished yet", time: { start: 1 } });
  addPart(d, "prt_09", "msg_a1", ROOT, T - 19 * 60_000 + 10, T - 19 * 60_000 + 10, { type: "step-start" });

  // CHILD: explore subagent, finished long enough ago to be done.
  addSession(d, { id: CHILD, parent: ROOT, title: "Explore the tests (@explore subagent)", agent: "explore", created: T - 16 * 60_000, updated: T - 14 * 60_000, cost: 0.1, tokens: [200, 100, 0, 1000, 0] });
  addMessage(d, "msg_c1", CHILD, T - 16 * 60_000, T - 14 * 60_000, asst(T - 16 * 60_000, T - 14 * 60_000));
  addPart(d, "prt_c1", "msg_c1", CHILD, T - 15 * 60_000, T - 15 * 60_000 + 100, {
    type: "tool",
    tool: "grep",
    callID: "call_g",
    state: { status: "completed", input: { pattern: "describe\\(" }, output: "3 matches", time: { start: 1, end: 2 } },
  });

  // OLD: finished 3 days ago (outside a 24 h window).
  addSession(d, { id: OLD, title: "Old work", agent: "plan", created: T - 73 * 3600_000, updated: T - 72 * 3600_000, cost: 0.05, tokens: [10, 10, 0, 0, 0] });
  addMessage(d, "msg_o1", OLD, T - 73 * 3600_000, T - 72 * 3600_000, asst(T - 73 * 3600_000, T - 72 * 3600_000));

  // FAILED: last assistant message ended with an API error 2 hours ago.
  addSession(d, { id: FAILED, title: "Broken model", agent: "build", created: T - 3 * 3600_000, updated: T - 2 * 3600_000, cost: 0, tokens: [0, 0, 0, 0, 0] });
  addMessage(d, "msg_f1", FAILED, T - 3 * 3600_000, T - 2 * 3600_000, asst(T - 3 * 3600_000, T - 3 * 3600_000 + 700, { error: { name: "APIError", data: { message: "Model not supported" } } }));
  d.close();
  return { dir, db };
}
