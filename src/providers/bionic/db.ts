/**
 * bionic/db.ts -- read-only access to a project's `.internal/ng-sessions.sqlite`.
 *
 * Opened with `node:sqlite` DatabaseSync `{ readOnly: true }` for each pass and closed right after.
 * `immutable=1` is deliberately NOT used: the DB is in WAL mode and immutable reads would miss what is
 * still in the -wal file. Only the `sessions` and `chat_entries` tables are queried.
 */
import type { DatabaseSync } from "node:sqlite";
import { loadSqlite } from "../sqlite.js";
import { isObj, num, str } from "../common.js";
import type { Entry } from "./format.js";

export interface SessionRow {
  id: string;
  name?: string;
  suggested?: string;
  head?: string;
  sessionJson?: string;
  updated: number;
  transient: boolean;
  temporary: boolean;
  parent?: string;
  companion?: string;
  unread: boolean;
}

const WANT = [
  "session_id",
  "session_name",
  "suggested_session_name",
  "committed_head_entry_id",
  "session_json",
  "updated_timestamp",
  "is_transient",
  "is_temporary",
  "parent_session_id",
  "companion_session_as",
  "has_unread",
];

/** Chain walks stop here (a cycle in `previous_id` must not hang a pass). */
const MAX_CHAIN = 50_000;

export type Db = DatabaseSync;

/** Opens the DB read-only; undefined when node:sqlite or the file is unusable. */
export async function openReadOnly(file: string): Promise<Db | undefined> {
  const mod = await loadSqlite();
  if (!mod) return undefined;
  try {
    return new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

export function closeQuietly(db: Db): void {
  try {
    db.close();
  } catch {
    // Already closed / never opened.
  }
}

/** Every session row (no chat entries). Missing columns are simply not selected. */
export function readSessions(db: Db): SessionRow[] {
  const have = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((r) => (isObj(r) ? str(r["name"]) : undefined)));
  const cols = WANT.filter((c) => have.has(c));
  if (!cols.includes("session_id")) return [];
  const out: SessionRow[] = [];
  for (const r of db.prepare(`SELECT ${cols.join(", ")} FROM sessions`).all()) {
    if (!isObj(r)) continue;
    const id = str(r["session_id"]);
    if (!id) continue;
    const row: SessionRow = {
      id,
      updated: num(r["updated_timestamp"]) ?? 0,
      transient: num(r["is_transient"]) === 1,
      temporary: num(r["is_temporary"]) === 1,
      unread: num(r["has_unread"]) === 1,
    };
    const set = <K extends "name" | "suggested" | "head" | "sessionJson" | "parent" | "companion">(k: K, v: string | undefined): void => {
      if (v !== undefined) row[k] = v;
    };
    set("name", str(r["session_name"]));
    set("suggested", str(r["suggested_session_name"]));
    set("head", str(r["committed_head_entry_id"]));
    set("sessionJson", str(r["session_json"]));
    set("parent", str(r["parent_session_id"]));
    set("companion", str(r["companion_session_as"]));
    out.push(row);
  }
  return out;
}

const CHAIN_SQL = `WITH RECURSIVE chain(id, previous_id, entry_json, d) AS (
  SELECT id, previous_id, entry_json, 0 FROM chat_entries WHERE id = ?
  UNION ALL
  SELECT e.id, e.previous_id, e.entry_json, c.d + 1 FROM chat_entries e JOIN chain c ON e.id = c.previous_id WHERE c.d < ${MAX_CHAIN}
) SELECT entry_json FROM chain ORDER BY d DESC`;

/** The entries of one session, oldest first, by walking `previous_id` back from the committed head. */
export function readChain(db: Db, head: string): Entry[] {
  const out: Entry[] = [];
  for (const r of db.prepare(CHAIN_SQL).all(head)) {
    if (!isObj(r)) continue;
    const raw = r["entry_json"];
    if (typeof raw !== "string") continue;
    try {
      const j: unknown = JSON.parse(raw);
      if (isObj(j)) out.push(j);
    } catch {
      // A corrupt entry is skipped, never fatal.
    }
  }
  return out;
}
