/**
 * antigravity/format.ts -- everything we know about Antigravity's on-disk index, in one place.
 *
 * The only file this provider ever reads is `conversation_summaries.db` (SQLite). Observed on a real
 * install (verified with `sqlite3 -readonly`): empty strings instead of NULLs, timestamps as ISO-8601
 * TEXT with microseconds ("2026-09-27 13:36:21.765656+00:00"), `workspace_uris` a JSON list of file://
 * URIs (or ""), `status` like "CASCADE_RUN_STATUS_IDLE". Everything is parsed defensively because the
 * format is internal: numbers (epoch s / ms / us) and other spellings are accepted too.
 */
import { fileURLToPath } from "node:url";
import { isObj, str } from "../common.js";
import type { AgentState } from "../types.js";

/** Columns we read. `preview` and `raw_summary` (opaque blob) are deliberately never selected. */
export const WANT_COLUMNS = [
  "conversation_id",
  "title",
  "agent_name",
  "source",
  "step_count",
  "last_modified_time",
  "last_user_input_time",
  "workspace_uris",
  "status",
  "not_fully_idle",
  "killed",
  "parent_conversation_id",
  "nesting_depth",
  "battle_id",
  "winning_conversation_id",
] as const;

export interface ConvRow {
  id: string;
  title: string;
  agentName: string;
  source: string;
  stepCount: number;
  lastModified?: number;
  lastUserInput?: number;
  /** First workspace as an absolute path ("" when none). */
  workspace: string;
  /** Raw `status` (as stored). */
  status: string;
  notFullyIdle: boolean;
  killed: boolean;
  parent: string;
  depth: number;
  battleId: string;
  winner: string;
}

/** Conversation ids are UUIDs today; accept any short token of safe characters (never used as a path). */
export function isConversationId(s: string): boolean {
  return /^[0-9a-z][0-9a-z_-]{5,79}$/i.test(s);
}

/** ISO text or epoch number (s / ms / us) -> epoch ms. Zero/Go-zero times and garbage -> undefined. */
export function parseTime(v: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return undefined;
    ms = v > 1e14 ? v / 1000 : v > 1e11 ? v : v * 1000;
  } else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseTime(Number(t));
    const iso = t.replace(" ", "T").replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
    ms = Date.parse(iso);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return ms >= Date.parse("1990-01-01T00:00:00Z") ? ms : undefined;
}

function truthy(v: unknown): boolean {
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return /^(1|true|t|yes)$/i.test(v.trim());
  return v === true;
}

function toInt(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** First workspace of `workspace_uris` (JSON list of strings / objects, or a plain separated list) as a path. */
export function firstWorkspace(v: unknown): string {
  const raw = str(v)?.trim();
  if (!raw) return "";
  let items: unknown[] = [];
  try {
    const j: unknown = JSON.parse(raw);
    items = Array.isArray(j) ? j : [j];
  } catch {
    items = raw.split(/[\s,;]+/);
  }
  for (const it of items) {
    const uri = typeof it === "string" ? it : isObj(it) ? (str(it["uri"]) ?? str(it["path"]) ?? str(it["fsPath"])) : undefined;
    const p = uri ? uriToPath(uri) : undefined;
    if (p) return p;
  }
  return "";
}

function uriToPath(uri: string): string | undefined {
  const u = uri.trim();
  if (!u) return undefined;
  if (u.startsWith("file://")) {
    try {
      return fileURLToPath(u).replace(/\/+$/, "") || "/";
    } catch {
      return undefined;
    }
  }
  return u.startsWith("/") ? u : undefined;
}

/** A raw DB record -> ConvRow; undefined when it has no usable id. */
export function toConvRow(r: Record<string, unknown>): ConvRow | undefined {
  const id = str(r["conversation_id"]);
  if (!id || !isConversationId(id)) return undefined;
  const row: ConvRow = {
    id,
    title: str(r["title"]) ?? "",
    agentName: str(r["agent_name"]) ?? "",
    source: str(r["source"]) ?? "",
    stepCount: toInt(r["step_count"]),
    workspace: firstWorkspace(r["workspace_uris"]),
    status: str(r["status"]) ?? "",
    notFullyIdle: truthy(r["not_fully_idle"]),
    killed: truthy(r["killed"]),
    parent: str(r["parent_conversation_id"]) ?? "",
    depth: toInt(r["nesting_depth"]),
    battleId: str(r["battle_id"]) ?? "",
    winner: str(r["winning_conversation_id"]) ?? "",
  };
  const lm = parseTime(r["last_modified_time"]);
  const lu = parseTime(r["last_user_input_time"]);
  if (lm !== undefined) row.lastModified = lm;
  if (lu !== undefined) row.lastUserInput = lu;
  return row;
}

export interface Liveness {
  state: AgentState;
  /** Value for SessionSummary.status: "busy" / "idle" for known statuses, else the raw status lowercased. */
  label?: string;
}

/** Idle rows younger than this are "idle" (live), older ones "done". */
export const IDLE_LIVE_MS = 2 * 60 * 1000;
/** A row that claims to be running but has not changed for this long is "stalled". */
export const RUN_FRESH_MS = 10 * 60 * 1000;

const RUNNING_RE = /(^|_)(RUNNING|ACTIVE|BUSY)(_|$)/;
const IDLE_RE = /(^|_)IDLE(_|$)/;

/**
 * Status mapping (by name, never by number):
 *  killed=1                              -> stopped
 *  ...RUNNING / ACTIVE / BUSY...         -> running (stalled when untouched for RUN_FRESH_MS)
 *  ...IDLE + not_fully_idle=1, fresh     -> running
 *  ...IDLE (or empty status)             -> idle when fresh (IDLE_LIVE_MS), else done
 *  anything else                         -> idle when fresh, else done; label = raw status lowercased
 * Liveness is judged from last_modified_time only, never from the DB file mtime (it is mmapped).
 */
export function liveness(row: ConvRow, now: number): Liveness {
  const age = row.lastModified === undefined ? Infinity : Math.max(0, now - row.lastModified);
  const s = row.status.toUpperCase();
  const known = s === "" || RUNNING_RE.test(s) || IDLE_RE.test(s);
  const fresh = age <= IDLE_LIVE_MS;
  const out = (state: AgentState, label?: string): Liveness => (label ? { state, label } : { state });
  if (row.killed) return out("stopped", known ? undefined : row.status.toLowerCase());
  if (RUNNING_RE.test(s)) return out(age <= RUN_FRESH_MS ? "running" : "stalled", age <= RUN_FRESH_MS ? "busy" : undefined);
  if (row.notFullyIdle && age <= RUN_FRESH_MS) return out("running", "busy");
  if (!known) return out(fresh ? "idle" : "done", row.status.toLowerCase());
  return fresh ? out("idle", "idle") : out("done");
}
