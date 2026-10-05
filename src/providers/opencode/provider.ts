/**
 * opencode/provider.ts -- opencode (and the Kilo Code fork) sessions from its SQLite store. Strictly
 * read-only: the DB is opened with `node:sqlite` `{ readOnly: true }` for each pass and closed right
 * after (no long-lived handle, never `immutable=1` -- the DB is WAL and immutable would miss the -wal).
 *
 * Mapping: a `session` row without `parent_id` is a session; child sessions are subagents nested
 * recursively. Tokens and cost come from the session columns (opencode records its own cost, which
 * we prefer over any estimate). Events come from `part` rows (text / reasoning / tool).
 *
 * Live heuristic (no processes are inspected; opencode has no pid or lock file):
 *   running  -- the newest assistant message has no `time.completed` (and no error) AND
 *               session.time_updated is within the stall threshold (default 10 min);
 *   idle     -- otherwise, session.time_updated within the live window (default 2 min);
 *   failed / stopped -- otherwise, when the newest assistant message ended with an error / abort;
 *   done     -- otherwise.
 * A session is live when its main agent is running/idle or any subagent is running.
 *
 * Updates: rows change in place, so each poll only re-reads sessions whose `time_updated` moved (plus
 * recently active ones) and, per session, messages/parts with `time_updated` past a per-session cursor.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { maskSecrets } from "../../mask.js";
import {
  ACTIVITY_KEEP_MIN,
  activityBuckets,
  addUsage,
  clipLine,
  displayHome,
  emptyUsage,
  isObj,
  localDay,
  num,
  sessionKey,
  str,
  tickOffsets,
  totalTokens,
} from "../common.js";
import { safeToRead } from "../guard.js";
import { loadSqlite } from "../sqlite.js";
import type {
  AgentNode,
  AgentState,
  EventQuery,
  EventsResult,
  MachineSummary,
  Provider,
  ProviderStatus,
  SessionDetail,
  SessionSummary,
  StreamEvent,
  ToolAction,
  Usage,
} from "../types.js";
import { describeTool, isNativeId, isSettled, parseJson, partToEvents, toMs, type PartRow } from "./format.js";

type Db = InstanceType<typeof import("node:sqlite").DatabaseSync>;

export interface OpencodeOptions {
  id: string;
  label: string;
  /** Letter mark for badges, e.g. "OC". */
  mark: string;
  /** Absolute path of the SQLite file. It is the only file ever opened. */
  dbPath: string;
  recentMs?: number;
  /** A running turn without updates for this long is no longer "running". Default 10 min. */
  stallMs?: number;
  /** A session updated within this window is "live". Default 2 min. */
  liveMs?: number;
  pollMs?: number;
  now?: () => number;
  userHome?: string;
}

interface SessRow {
  id: string;
  parentId?: string;
  title: string;
  directory: string;
  agent: string;
  model?: string;
  version?: string;
  createdAt: number;
  updatedAt: number;
  cost: number;
  usage: Usage;
}

interface MsgInfo {
  role: string;
  createdAt: number;
  completedAt?: number;
  error?: { name: string; message: string };
  model?: string;
}

interface Track {
  row: SessRow;
  msgCursor: number;
  partCursor: number;
  msgs: Map<string, MsgInfo>;
  toolIds: Set<string>;
  /** Running / pending tool calls by part id. */
  pending: Map<string, { createdAt: number; tool: string; action: ToolAction }>;
  ticks: number[];
  minutes: Map<number, number>;
  toolCalls: number;
  firstAt?: number;
  lastPrompt?: string;
  lastPromptAt: number;
  /** child session id -> spawning task call id. */
  spawns: Map<string, string>;
  refreshedFor: number;
}

const FULL_SCAN_MS = 15_000;
const MAX_TICKS_KEPT = 20_000;
const MAX_ROWS = 20_000;

const SESSION_COLS = [
  "id",
  "parent_id",
  "title",
  "directory",
  "agent",
  "model",
  "version",
  "time_created",
  "time_updated",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
];

function newTrack(row: SessRow): Track {
  return {
    row,
    msgCursor: -1,
    partCursor: -1,
    msgs: new Map(),
    toolIds: new Set(),
    pending: new Map(),
    ticks: [],
    minutes: new Map(),
    toolCalls: 0,
    lastPromptAt: 0,
    spawns: new Map(),
    refreshedFor: -1,
  };
}

function toRow(r: Record<string, unknown>): SessRow | undefined {
  const id = str(r["id"]);
  if (!id || !isNativeId(id)) return undefined;
  const n = (k: string): number => toMs(r[k]) ?? 0;
  const m = parseJson(r["model"]);
  const row: SessRow = {
    id,
    title: str(r["title"]) ?? "",
    directory: str(r["directory"]) ?? "",
    agent: str(r["agent"]) ?? "build",
    createdAt: n("time_created"),
    updatedAt: n("time_updated"),
    cost: n("cost"),
    // Reasoning tokens are billed as output.
    usage: { input: n("tokens_input"), output: n("tokens_output") + n("tokens_reasoning"), cacheRead: n("tokens_cache_read"), cacheCreate: n("tokens_cache_write") },
  };
  const parent = str(r["parent_id"]);
  if (parent && isNativeId(parent)) row.parentId = parent;
  const model = str(m?.["id"]) ?? str(m?.["modelID"]);
  if (model) row.model = model;
  const version = str(r["version"]);
  if (version) row.version = version;
  return row;
}

export class OpencodeProvider extends EventEmitter implements Provider {
  readonly id: string;
  readonly label: string;
  readonly dbPath: string;
  private readonly mark: string;
  private readonly recentMs: number;
  private readonly stallMs: number;
  private readonly liveMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly userHome: string;

  private rows = new Map<string, SessRow>();
  private tracks = new Map<string, Track>();
  private parentOf = new Map<string, string>();
  private childrenOf = new Map<string, string[]>();
  private lastFull = 0;
  private scanning = false;
  private rescan = false;
  private timer: NodeJS.Timeout | undefined;
  private lastSignature = "";
  private dbState: "ok" | "missing" | "error" = "missing";
  private totalSessions = 0;
  private lastUpdate = 0;
  private today = { output: 0, cost: 0 };
  loading = true;

  constructor(opts: OpencodeOptions) {
    super();
    this.id = opts.id;
    this.label = opts.label;
    this.mark = opts.mark;
    this.dbPath = opts.dbPath;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.stallMs = opts.stallMs ?? 10 * 60 * 1000;
    this.liveMs = opts.liveMs ?? 2 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 3000;
    this.now = opts.now ?? Date.now;
    this.userHome = opts.userHome ?? homedir();
  }

  /** The DB file is the only allowed root (auth.json and config live next to it and stay unreachable). */
  private get roots(): string[] {
    return [this.dbPath];
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  onChange(fn: (sessionIds: string[]) => void): void {
    this.on("change", fn);
  }

  start(): void {
    void this.scan(true);
    this.timer = setInterval(() => void this.scan(false), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- database access ---------------------------------------------------------------------

  private async open(): Promise<Db | undefined> {
    if (!existsSync(this.dbPath)) {
      this.dbState = "missing";
      return undefined;
    }
    if (!safeToRead(this.dbPath, this.roots)) {
      this.dbState = "error";
      return undefined;
    }
    const mod = await loadSqlite();
    if (!mod) {
      this.dbState = "error";
      return undefined;
    }
    try {
      const db = new mod.DatabaseSync(this.dbPath, { readOnly: true });
      this.dbState = "ok";
      return db;
    } catch {
      this.dbState = "error";
      return undefined;
    }
  }

  private loadSessions(db: Db): SessRow[] {
    const have = new Set(
      db
        .prepare("PRAGMA table_info(session)")
        .all()
        .map((c) => (isObj(c) ? str(c["name"]) : undefined))
        .filter((x): x is string => x !== undefined),
    );
    if (!have.has("id") || !have.has("time_updated")) throw new Error("unexpected session schema");
    const sel = SESSION_COLS.filter((c) => have.has(c)).join(", ");
    const out: SessRow[] = [];
    for (const r of db.prepare(`SELECT ${sel} FROM session ORDER BY time_updated DESC LIMIT ${MAX_ROWS}`).all()) {
      const row = isObj(r) ? toRow(r) : undefined;
      if (row) out.push(row);
    }
    return out;
  }

  // ---- scanning ----------------------------------------------------------------------------

  async scan(full = false): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    const changed = new Set<string>();
    try {
      const now = this.now();
      const doFull = full || now - this.lastFull > FULL_SCAN_MS;
      const db = await this.open();
      if (db) {
        try {
          await this.pass(db, now, doFull, changed);
          if (doFull) this.lastFull = now;
        } catch {
          this.dbState = "error";
        } finally {
          db.close();
        }
      }
    } finally {
      this.scanning = false;
      this.loading = false;
    }
    const sig = this.signature();
    if (changed.size > 0 || sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.emit("change", [...changed]);
    }
    if (this.rescan) {
      this.rescan = false;
      void this.scan(false);
    }
  }

  private async pass(db: Db, now: number, doFull: boolean, changed: Set<string>): Promise<void> {
    const all = this.loadSessions(db);
    this.rows = new Map(all.map((r) => [r.id, r]));
    this.totalSessions = all.length;
    this.lastUpdate = all.reduce((m, r) => Math.max(m, r.updatedAt), 0);

    // Structure: parents / children among known rows.
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, string[]>();
    for (const r of all) {
      if (r.parentId && this.rows.has(r.parentId) && r.parentId !== r.id) {
        parentOf.set(r.id, r.parentId);
        const l = childrenOf.get(r.parentId) ?? [];
        l.push(r.id);
        childrenOf.set(r.parentId, l);
      }
    }
    this.parentOf = parentOf;
    this.childrenOf = childrenOf;

    // Listed = every tree whose newest member is inside the recent window (or still live).
    const since = now - this.recentMs;
    const listed = new Set<string>();
    for (const r of all) {
      if (parentOf.has(r.id)) continue;
      const tree = this.treeIds(r.id);
      const newest = tree.reduce((m, id) => Math.max(m, this.rows.get(id)?.updatedAt ?? 0), 0);
      if (newest >= since || now - newest <= this.stallMs) for (const id of tree) listed.add(id);
    }
    for (const id of [...this.tracks.keys()]) if (!listed.has(id)) this.tracks.delete(id);

    for (const id of listed) {
      const row = this.rows.get(id);
      if (!row) continue;
      let t = this.tracks.get(id);
      if (!t) {
        t = newTrack(row);
        this.tracks.set(id, t);
      }
      t.row = row;
      const active = now - row.updatedAt <= this.stallMs;
      if (t.refreshedFor === row.updatedAt && !active) continue;
      if (this.refresh(db, t, now)) changed.add(this.globalId(this.rootOf(id)));
      t.refreshedFor = row.updatedAt;
      await yieldToLoop();
    }
    if (doFull) this.readToday(db, now);
  }

  private treeIds(rootId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      if (seen.has(id) || depth > 32) return;
      seen.add(id);
      out.push(id);
      for (const c of this.childrenOf.get(id) ?? []) walk(c, depth + 1);
    };
    walk(rootId, 0);
    return out;
  }

  private rootOf(id: string): string {
    let cur = id;
    for (let i = 0; i < 40; i++) {
      const p = this.parentOf.get(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  }

  private globalId(nativeId: string): string {
    return sessionKey(this.id, nativeId);
  }

  /** Incremental read of one session's messages and parts. Returns true when anything new arrived. */
  private refresh(db: Db, t: Track, now: number): boolean {
    let any = false;
    const id = t.row.id;
    const msgs = db.prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? AND time_updated > ? ORDER BY time_updated LIMIT 5000").all(id, t.msgCursor);
    for (const r of msgs) {
      if (!isObj(r)) continue;
      const mid = str(r["id"]);
      const upd = toMs(r["time_updated"]);
      if (!mid || upd === undefined) continue;
      t.msgCursor = Math.max(t.msgCursor, upd);
      const d = parseJson(r["data"]);
      const role = str(d?.["role"]);
      if (!d || !role) continue;
      const time = isObj(d["time"]) ? d["time"] : {};
      const info: MsgInfo = { role, createdAt: toMs(r["time_created"]) ?? num(time["created"]) ?? 0 };
      const done = num(time["completed"]);
      if (done !== undefined) info.completedAt = done;
      const model = role === "assistant" ? str(d["modelID"]) : undefined;
      if (model) info.model = model;
      if (isObj(d["error"])) {
        const e = d["error"];
        const name = str(e["name"]) ?? "Error";
        const msg = isObj(e["data"]) ? str(e["data"]["message"]) : undefined;
        info.error = { name, message: msg ?? name };
      }
      t.msgs.set(mid, info);
      any = true;
    }

    const parts = db.prepare("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? AND time_updated > ? ORDER BY time_updated LIMIT 20000").all(id, t.partCursor);
    for (const r of parts) {
      if (!isObj(r)) continue;
      const pid = str(r["id"]);
      const created = toMs(r["time_created"]);
      const upd = toMs(r["time_updated"]);
      if (!pid || created === undefined || upd === undefined) continue;
      t.partCursor = Math.max(t.partCursor, upd);
      const d = parseJson(r["data"]);
      if (!d) continue;
      any = true;
      if (t.firstAt === undefined || created < t.firstAt) t.firstAt = created;
      const type = str(d["type"]);
      if (type === "tool") {
        const tool = str(d["tool"]) ?? "tool";
        const state = isObj(d["state"]) ? d["state"] : {};
        if (!t.toolIds.has(pid)) {
          t.toolIds.add(pid);
          t.toolCalls++;
          if (t.ticks.length < MAX_TICKS_KEPT) t.ticks.push(created);
          this.bump(t, created, now);
        }
        const status = str(state["status"]);
        if (status === "completed" || status === "error") t.pending.delete(pid);
        else t.pending.set(pid, { createdAt: created, tool, action: describeTool(tool, state["input"]).action });
        if (tool === "task" && isObj(state["metadata"])) {
          const child = str(state["metadata"]["sessionId"]) ?? str(state["metadata"]["sessionID"]);
          const call = str(d["callID"]);
          if (child && call) t.spawns.set(child, call);
        }
      } else if (type === "text") {
        const mid = str(r["message_id"]);
        if (mid && t.msgs.get(mid)?.role === "user" && d["synthetic"] !== true && d["ignored"] !== true) {
          const text = str(d["text"]);
          if (text && created >= t.lastPromptAt) {
            t.lastPrompt = clipLine(text, 300);
            t.lastPromptAt = created;
          }
        }
        this.bump(t, created, now);
      } else if (type === "reasoning") this.bump(t, created, now);
    }
    if (any) {
      const keep = Math.floor(now / 60000) - ACTIVITY_KEEP_MIN;
      for (const m of t.minutes.keys()) if (m < keep) t.minutes.delete(m);
    }
    return any;
  }

  private bump(t: Track, ms: number, now: number): void {
    const m = Math.floor(ms / 60000);
    if (m >= Math.floor(now / 60000) - ACTIVITY_KEEP_MIN) t.minutes.set(m, (t.minutes.get(m) ?? 0) + 1);
  }

  /** Output tokens and recorded cost of assistant messages created today (local day). */
  private readToday(db: Db, now: number): void {
    const d = new Date(now);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let output = 0;
    let cost = 0;
    const stmt = db.prepare(
      "SELECT SUM(COALESCE(json_extract(data, '$.tokens.output'), 0) + COALESCE(json_extract(data, '$.tokens.reasoning'), 0)) AS o, SUM(COALESCE(json_extract(data, '$.cost'), 0)) AS c FROM message WHERE session_id = ? AND time_created >= ? AND json_extract(data, '$.role') = 'assistant'",
    );
    for (const r of this.rows.values()) {
      if (r.updatedAt < dayStart) continue;
      const x = stmt.get(r.id, dayStart);
      if (isObj(x)) {
        output += toMs(x["o"]) ?? 0;
        cost += num(x["c"]) ?? 0;
      }
    }
    this.today = { output, cost };
  }

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.runningAgents}|${s.agentCount}|${s.totalTokens}|${s.lastActivityAt}`)
      .join("\n");
  }

  // ---- state -------------------------------------------------------------------------------

  private lastAssistant(t: Track): MsgInfo | undefined {
    let best: MsgInfo | undefined;
    for (const m of t.msgs.values()) if (m.role === "assistant" && (!best || m.createdAt >= best.createdAt)) best = m;
    return best;
  }

  private state(t: Track): AgentState {
    const age = this.now() - t.row.updatedAt;
    const last = this.lastAssistant(t);
    const open = last !== undefined && last.completedAt === undefined && last.error === undefined;
    if (open && age <= this.stallMs) return "running";
    if (age <= this.liveMs) return "idle";
    if (last?.error) return last.error.name === "MessageAbortedError" ? "stopped" : "failed";
    return "done";
  }

  private modelOf(t: Track): string | undefined {
    return this.lastAssistant(t)?.model ?? t.row.model;
  }

  // ---- queries -----------------------------------------------------------------------------

  isSessionId(id: string): boolean {
    return isNativeId(id);
  }

  private rootTracks(): Track[] {
    return [...this.tracks.values()].filter((t) => !this.parentOf.has(t.row.id));
  }

  private descendants(id: string): Track[] {
    return this.treeIds(id)
      .slice(1)
      .map((c) => this.tracks.get(c))
      .filter((x): x is Track => x !== undefined);
  }

  listSessions(): SessionSummary[] {
    return this.rootTracks().map((t) => this.summarize(t));
  }

  private name(t: Track): string {
    const title = t.row.title.trim();
    return maskSecrets(title || (t.lastPrompt ?? t.row.id.slice(0, 12)));
  }

  private summarize(root: Track): SessionSummary {
    const now = this.now();
    const tree = [root, ...this.descendants(root.row.id)];
    const usage = emptyUsage();
    const minutes = new Map<number, number>();
    let cost = 0;
    let running = 0;
    let first: number | undefined;
    let last = 0;
    for (const t of tree) {
      addUsage(usage, t.row.usage);
      cost += t.row.cost;
      for (const [m, c] of t.minutes) minutes.set(m, (minutes.get(m) ?? 0) + c);
      if (t !== root && this.state(t) === "running") running++;
      const f = t.firstAt ?? t.row.createdAt;
      if (f > 0 && (first === undefined || f < first)) first = f;
      last = Math.max(last, t.row.updatedAt);
    }
    const st = this.state(root);
    const live = st === "running" || st === "idle" || running > 0;
    const dir = maskSecrets(root.row.directory);
    const sum: SessionSummary = {
      id: this.globalId(root.row.id),
      provider: this.id,
      projectDir: dir,
      cwd: dir,
      live,
      name: this.name(root),
      entrypoint: this.label,
      kind: root.row.agent,
      lastActivityAt: last,
      hasTranscript: true,
      agentCount: tree.length - 1,
      runningAgents: running,
      usage,
      totalTokens: totalTokens(usage),
      costUsd: cost,
      activity: activityBuckets(minutes, now),
    };
    if (live) {
      sum.status = st === "running" ? "busy" : "idle";
      if (root.row.createdAt > 0) sum.startedAt = root.row.createdAt;
    }
    if (root.row.version) sum.version = root.row.version;
    if (first !== undefined) sum.firstActivityAt = first;
    const model = this.modelOf(root);
    if (model) sum.model = model;
    if (root.lastPrompt) sum.lastPrompt = root.lastPrompt;
    return sum;
  }

  getSession(nativeId: string): SessionDetail | undefined {
    const root = this.tracks.get(nativeId);
    if (!root || this.parentOf.has(root.row.id)) return undefined;
    const sum = this.summarize(root);
    const usageByModel: Record<string, Usage> = {};
    const costByModel: Record<string, number | null> = {};
    const usageSubagents = emptyUsage();
    for (const t of [root, ...this.descendants(root.row.id)]) {
      const m = this.modelOf(t) ?? "unknown";
      addUsage((usageByModel[m] ??= emptyUsage()), t.row.usage);
      costByModel[m] = (costByModel[m] ?? 0) + t.row.cost;
      if (t !== root) addUsage(usageSubagents, t.row.usage);
    }
    return { ...sum, tree: this.node(root, root, 0), usageByModel, costByModel, usageMain: { ...root.row.usage }, usageSubagents };
  }

  private node(t: Track, root: Track, depth: number): AgentNode {
    const isMain = t === root;
    const now = this.now();
    const state = this.state(t);
    const startedAt = t.row.createdAt > 0 ? t.row.createdAt : t.firstAt;
    const lastActivityAt = t.row.updatedAt || undefined;
    const active = state === "running" || state === "idle";
    const end = active ? now : (lastActivityAt ?? now);
    const parentId = this.parentOf.get(t.row.id);
    const node: AgentNode = {
      key: isMain ? "main" : t.row.id,
      provider: this.id,
      label: isMain ? this.name(t) : maskSecrets(t.row.title.trim() || `alt ajan ${t.row.id.slice(4, 12)}`),
      agentType: isMain ? "main" : maskSecrets(t.row.agent),
      mode: isMain ? "main" : "unknown",
      state,
      durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
      usage: { ...t.row.usage },
      totalTokens: totalTokens(t.row.usage),
      messages: t.msgs.size,
      toolCalls: t.toolCalls,
      ticks: tickOffsets(t.ticks, startedAt),
      costUsd: t.row.cost,
      parentKey: isMain ? null : parentId === root.row.id ? "main" : (parentId ?? "main"),
      children: [],
    };
    const model = this.modelOf(t);
    if (model) node.model = model;
    if (startedAt !== undefined) node.startedAt = startedAt;
    if (lastActivityAt !== undefined) {
      node.lastActivityAt = lastActivityAt;
      if (!active) node.endedAt = lastActivityAt;
    }
    if (state === "running") {
      let cur: { createdAt: number; tool: string; action: ToolAction } | undefined;
      for (const p of t.pending.values()) if (!cur || p.createdAt >= cur.createdAt) cur = p;
      if (cur) {
        node.lastAction = cur.action;
        node.lastTool = maskSecrets(cur.tool);
      }
    }
    if (state === "failed" || state === "stopped") {
      const e = this.lastAssistant(t)?.error;
      node.endReason = state === "stopped" ? "İptal edildi" : clipLine(e?.message ?? "Hata", 200);
    }
    if (!isMain && parentId) {
      const call = this.tracks.get(parentId)?.spawns.get(t.row.id);
      if (call) node.toolUseId = call;
    }
    if (depth < 32) {
      node.children = (this.childrenOf.get(t.row.id) ?? [])
        .map((c) => this.tracks.get(c))
        .filter((x): x is Track => x !== undefined)
        .map((k) => this.node(k, root, depth + 1))
        .sort((x, y) => (x.startedAt ?? Infinity) - (y.startedAt ?? Infinity));
    }
    return node;
  }

  machine(): MachineSummary {
    const today = localDay(this.now());
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: this.today.output, costToday: this.today.cost };
    for (const s of this.listSessions()) if (s.live) out.liveSessions++;
    for (const t of this.tracks.values()) {
      const st = this.state(t);
      if (st === "running") out.runningAgents++;
      else if (this.parentOf.has(t.row.id) && (st === "done" || st === "failed" || st === "stopped") && localDay(t.row.updatedAt) === today) out.finishedToday++;
    }
    return out;
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    const dbName = this.dbPath.split("/").pop() ?? "db";
    const notes = [
      "Canlılık tahmini: son asistan mesajı tamamlanmamış + güncelleme (≤10 dk çalışıyor, ≤2 dk boşta); pid/kilit dosyası yok",
      this.dbState === "ok" ? `Kaynak: ${dbName} (salt okunur, her turda açılıp kapanır)` : this.dbState === "missing" ? `${dbName} bulunamadı` : `${dbName} okunamadı`,
      "Maliyet: araç kendi kaydını tutuyor (session.cost), tahmin değil",
      "Token: reasoning çıktıya dahil; oturum başına toplam, model dağılımı son asistan modeline atfedilir",
      "Biçim belgelenmemiş ve sürümler arası değişebilir; savunmacı ayrıştırma",
    ];
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: this.mark,
      installed: existsSync(dirname(this.dbPath)),
      dataFound: this.totalSessions > 0,
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: true, tokens: true, tools: true, subagents: true, cost: true },
      notes,
      home: displayHome(dirname(this.dbPath), this.userHome),
    };
    if (this.lastUpdate > 0) st.lastActivityAt = this.lastUpdate;
    if (sessions.length === 0 && this.totalSessions > 0) st.notes.push(`Son ${Math.round(this.recentMs / 3600_000)} saatte oturum yok (toplam ${this.totalSessions})`);
    return st;
  }

  // ---- events ------------------------------------------------------------------------------

  /** Validated session id for an agent key, or undefined when it is not part of this session's tree. */
  private agentSession(nativeId: string, agentKey: string): string | undefined {
    const root = this.tracks.get(nativeId);
    if (!root || this.parentOf.has(root.row.id)) return undefined;
    if (agentKey === "main") return root.row.id;
    return this.treeIds(root.row.id).includes(agentKey) ? agentKey : undefined;
  }

  async readEvents(nativeId: string, agentKey: string, opts: EventQuery): Promise<EventsResult | undefined> {
    const sid = this.agentSession(nativeId, agentKey);
    if (!sid) return undefined;
    const db = await this.open();
    if (!db) return undefined;
    try {
      return this.queryEvents(db, sid, opts);
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  }

  private queryEvents(db: Db, sid: string, opts: EventQuery): EventsResult {
    const now = this.now();
    const SEL = "SELECT p.id AS id, p.time_created AS c, p.time_updated AS u, p.data AS data, json_extract(m.data, '$.role') AS role FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.session_id = ?";
    const toParts = (rows: unknown[]): Array<{ part: PartRow; events: StreamEvent[] }> => {
      const out: Array<{ part: PartRow; events: StreamEvent[] }> = [];
      for (const r of rows) {
        if (!isObj(r)) continue;
        const id = str(r["id"]);
        const c = toMs(r["c"]);
        const u = toMs(r["u"]);
        const data = parseJson(r["data"]);
        if (!id || c === undefined || u === undefined || !data) continue;
        if (!isSettled(data, u, now)) continue;
        const part: PartRow = { id, createdAt: c, updatedAt: u, data };
        const role = str(r["role"]);
        if (role) part.role = role;
        const events = partToEvents(part);
        if (events.length > 0) out.push({ part, events });
      }
      return out;
    };

    if (opts.after !== undefined) {
      const LIMIT = 600;
      const rows = db.prepare(`${SEL} AND p.time_updated > ? ORDER BY p.time_updated, p.id LIMIT ${LIMIT}`).all(sid, opts.after);
      let cursor = opts.after;
      for (const r of rows) if (isObj(r)) cursor = Math.max(cursor, toMs(r["u"]) ?? 0);
      const events = toParts(rows).flatMap((p) => p.events);
      return { events, cursor, start: opts.after, truncated: rows.length >= LIMIT, reset: false };
    }

    const want = Math.max(1, Math.min(opts.tail ?? 150, 1000));
    const cur = db.prepare("SELECT MAX(time_updated) AS m FROM part WHERE session_id = ?").get(sid);
    const cursor = isObj(cur) ? (toMs(cur["m"]) ?? 0) : 0;
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    let limit = Math.max(want * 4, 200);
    for (;;) {
      const rows = db.prepare(`${SEL} AND p.time_created < ? ORDER BY p.time_created DESC, p.id DESC LIMIT ${limit}`).all(sid, before);
      const exhausted = rows.length < limit;
      let parts = toParts(rows).reverse();
      if (!exhausted && rows.length > 0) {
        // The oldest millisecond group may be cut by LIMIT; drop it (the next page starts there).
        const oldest = toMs((rows[rows.length - 1] as Record<string, unknown>)["c"]);
        parts = parts.filter((p) => p.part.createdAt !== oldest);
      }
      const total = parts.reduce((n, p) => n + p.events.length, 0);
      if (total >= want || exhausted || limit >= MAX_ROWS) {
        // Keep whole parts; never split a millisecond group across pages.
        let from = 0;
        let count = total;
        while (count > want && from < parts.length) {
          count -= parts[from]?.events.length ?? 0;
          from++;
        }
        while (from > 0 && parts[from - 1]?.part.createdAt === parts[from]?.part.createdAt) from--;
        const kept = parts.slice(from);
        const start = kept[0]?.part.createdAt ?? (opts.before ?? 0);
        const truncated = from > 0 || !exhausted;
        return { events: kept.flatMap((p) => p.events), cursor, start, truncated, reset: false };
      }
      limit *= 4;
    }
  }
}
