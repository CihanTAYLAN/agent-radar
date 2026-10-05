/**
 * codex/index-db.ts -- read-only access to Codex's thread index (`state_<n>.sqlite`).
 *
 * Opened with `node:sqlite` DatabaseSync `{ readOnly: true }` for each discovery pass and closed right
 * after, so we never hold a long-lived handle on the app's database. `immutable=1` is deliberately
 * NOT used: the DB is in WAL mode and immutable reads would miss everything still in the -wal file.
 * No other Codex database (thread_history, logs, queue, goals, memories...) is ever opened.
 *
 * `node:sqlite` is still flagged experimental on Node 22; its one-time ExperimentalWarning is
 * swallowed while the module loads. If the module or the DB is unavailable, callers fall back to
 * scanning rollout files.
 */
import { str, num, isObj } from "../common.js";
import { loadSqlite } from "../sqlite.js";
import { isThreadId, parseSource, type SourceInfo } from "./format.js";

export interface ThreadRow {
  id: string;
  rolloutPath: string;
  createdAt?: number;
  updatedAt: number;
  source: SourceInfo;
  modelProvider?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  title?: string;
  firstUserMessage?: string;
  tokensUsed?: number;
  archived: boolean;
  gitBranch?: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
  threadSource?: string;
  originator?: string;
  cliVersion?: string;
}

export interface SpawnEdge {
  parent: string;
  child: string;
  status?: string;
}

export interface IndexSnapshot {
  threads: Map<string, ThreadRow>;
  edges: SpawnEdge[];
}

const WANT = [
  "id",
  "rollout_path",
  "created_at",
  "created_at_ms",
  "updated_at",
  "updated_at_ms",
  "source",
  "model_provider",
  "model",
  "reasoning_effort",
  "cwd",
  "title",
  "first_user_message",
  "tokens_used",
  "archived",
  "git_branch",
  "agent_nickname",
  "agent_role",
  "agent_path",
  "thread_source",
  "originator",
  "cli_version",
];

function toRow(r: Record<string, unknown>): ThreadRow | undefined {
  const id = str(r["id"])?.toLowerCase();
  const rolloutPath = str(r["rollout_path"]);
  if (!id || !isThreadId(id) || !rolloutPath) return undefined;
  const sec = (v: unknown): number | undefined => {
    const n = num(typeof v === "bigint" ? Number(v) : v);
    return n === undefined ? undefined : n * 1000;
  };
  const ms = (v: unknown): number | undefined => num(typeof v === "bigint" ? Number(v) : v);
  const updatedAt = ms(r["updated_at_ms"]) ?? sec(r["updated_at"]) ?? 0;
  const row: ThreadRow = { id, rolloutPath, updatedAt, source: parseSource(r["source"]), archived: Number(r["archived"] ?? 0) !== 0 };
  const put = <K extends keyof ThreadRow>(k: K, v: ThreadRow[K] | undefined) => {
    if (v !== undefined) row[k] = v;
  };
  put("createdAt", ms(r["created_at_ms"]) ?? sec(r["created_at"]));
  put("modelProvider", str(r["model_provider"]));
  put("model", str(r["model"]));
  put("effort", str(r["reasoning_effort"]));
  put("cwd", str(r["cwd"]));
  put("title", str(r["title"]));
  put("firstUserMessage", str(r["first_user_message"]));
  put("tokensUsed", ms(r["tokens_used"]));
  put("gitBranch", str(r["git_branch"]));
  put("nickname", str(r["agent_nickname"]) ?? row.source.nickname);
  put("role", str(r["agent_role"]) ?? row.source.role);
  put("agentPath", str(r["agent_path"]) ?? row.source.agentPath);
  put("threadSource", str(r["thread_source"]));
  put("originator", str(r["originator"]));
  put("cliVersion", str(r["cli_version"]));
  return row;
}

/**
 * Threads updated since `sinceMs`, plus their ancestors (so every subagent can be placed under its
 * root), plus all spawn edges between the returned threads. Throws when the DB cannot be read.
 */
export async function readIndex(dbPath: string, sinceMs: number): Promise<IndexSnapshot> {
  const mod = await loadSqlite();
  if (!mod) throw new Error("node:sqlite unavailable");
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(
      db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((c) => (isObj(c) ? str(c["name"]) : undefined))
        .filter((x): x is string => x !== undefined),
    );
    if (!cols.has("id") || !cols.has("rollout_path")) throw new Error("unexpected threads schema");
    const sel = WANT.filter((c) => cols.has(c)).join(", ");
    const upd = cols.has("updated_at_ms") ? "COALESCE(updated_at_ms, updated_at * 1000)" : "updated_at * 1000";
    const threads = new Map<string, ThreadRow>();
    for (const r of db.prepare(`SELECT ${sel} FROM threads WHERE ${upd} >= ? ORDER BY ${upd} DESC LIMIT 2000`).all(sinceMs)) {
      const row = isObj(r) ? toRow(r) : undefined;
      if (row) threads.set(row.id, row);
    }

    const edges: SpawnEdge[] = [];
    const hasEdges = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get() !== undefined;
    if (hasEdges) {
      for (const r of db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges").all()) {
        if (!isObj(r)) continue;
        const parent = str(r["parent_thread_id"])?.toLowerCase() ?? "";
        const child = str(r["child_thread_id"])?.toLowerCase() ?? "";
        if (!isThreadId(parent) || !isThreadId(child)) continue;
        const e: SpawnEdge = { parent, child };
        const status = str(r["status"]);
        if (status) e.status = status;
        edges.push(e);
      }
    }
    const parentOf = new Map<string, string>();
    for (const e of edges) parentOf.set(e.child, e.parent);

    // Pull in missing ancestors (a subagent updated today whose root was last touched earlier).
    const byId = db.prepare(`SELECT ${sel} FROM threads WHERE id = ?`);
    for (let pass = 0; pass < 6; pass++) {
      const missing = new Set<string>();
      for (const t of threads.values()) {
        const p = parentOf.get(t.id) ?? t.source.parentId;
        if (p && !threads.has(p)) missing.add(p);
      }
      if (missing.size === 0) break;
      for (const id of missing) {
        const r = byId.get(id);
        const row = isObj(r) ? toRow(r) : undefined;
        if (row) threads.set(row.id, row);
      }
    }
    return { threads, edges: edges.filter((e) => threads.has(e.child) && threads.has(e.parent)) };
  } finally {
    db.close();
  }
}
