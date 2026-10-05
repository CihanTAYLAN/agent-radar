/**
 * codex/provider.ts -- OpenAI Codex CLI + Codex desktop threads under ~/.codex. Strictly read-only.
 *
 * Discovery: the thread index `state_<n>.sqlite` (read-only, see index-db.ts) lists threads updated
 * within the recent window plus their ancestors; rollouts in recent `sessions/YYYY/MM/DD/` dirs are
 * added on top (new threads can appear there before the index row). Without the database, discovery
 * falls back to those date dirs and `archived_sessions/`, and subagent links come from each rollout's
 * `session_meta`.
 *
 * Mapping: a thread without a (known) parent is a session; subagent threads (thread_spawn_edges /
 * parent_thread_id) are agents nested under their parent, recursively.
 *
 * Live heuristic (no processes are inspected):
 *   running  -- the thread has an open turn (task_started without task_complete / turn_aborted)
 *               AND its rollout changed within the stall threshold (default 10 min);
 *   idle     -- otherwise, the rollout changed within the live window (default 2 min);
 *   done     -- otherwise (`stopped` when its last turn was aborted).
 * A session is live when its main thread is running/idle or any of its agents is running.
 */
import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { maskSecrets } from "../../mask.js";
import { codexPricingNote, openAiCostUsd, openAiPrice } from "../../pricing.js";
import { readNewLines, readTailLines } from "../../tail.js";
import {
  ACTIVITY_KEEP_MIN,
  activityBuckets,
  addUsage,
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
import {
  cleanTitle,
  describeCall,
  isThreadId,
  lineType,
  parseLine,
  payloadOf,
  peekHead,
  rolloutThreadId,
  sessionMeta,
  stateDbVersion,
  toEvents,
  toUsage,
  userPrompt,
  worthParsing,
  type SessionMeta,
  type ThreadKind,
} from "./format.js";
import { readIndex, type ThreadRow } from "./index-db.js";

export const PROVIDER_ID = "codex";
export const PROVIDER_LABEL = "Codex";

export interface CodexOptions {
  /** Codex home; default `$CODEX_HOME` or `~/.codex`. */
  codexHome: string;
  /** Threads updated within this window are listed. Default 24h. */
  recentMs?: number;
  /** An open turn older than this is no longer "running". Default 10 min. */
  stallMs?: number;
  /** A rollout modified within this window is "live". Default 2 min. */
  liveMs?: number;
  pollMs?: number;
  watch?: boolean;
  /** Read the SQLite index (default true); false forces the rollout-only fallback. */
  useDb?: boolean;
  now?: () => number;
  userHome?: string;
}

interface Buckets {
  usage: Usage;
  byModel: Map<string, Usage>;
  /** `<local day>|<model>` -> usage. */
  dayModel: Map<string, Usage>;
}

function newBuckets(): Buckets {
  return { usage: emptyUsage(), byModel: new Map(), dayModel: new Map() };
}

function bucket(m: Map<string, Usage>, k: string): Usage {
  let b = m.get(k);
  if (!b) {
    b = emptyUsage();
    m.set(k, b);
  }
  return b;
}

function addTo(b: Buckets, model: string, day: string, u: Usage): void {
  addUsage(b.usage, u);
  addUsage(bucket(b.byModel, model), u);
  addUsage(bucket(b.dayModel, `${day}|${model}`), u);
}

interface ThreadTrack {
  id: string;
  file: string;
  archived: boolean;
  row?: ThreadRow;
  meta?: SessionMeta;
  /** Parent from thread_spawn_edges (authoritative when present). */
  edgeParent?: string;
  edgeStatus?: string;
  offset: number;
  size: number;
  mtimeMs: number;
  firstTs?: number;
  lastTs?: number;
  openTurns: Set<string>;
  lastTurnEnd?: "complete" | "aborted";
  turns: number;
  model?: string;
  cwd?: string;
  effort?: string;
  /** From token_usage_record (preferred), deduplicated by response id. */
  rec: Buckets;
  recSeen: Set<string>;
  /** Fallback for rollouts without token_usage_record: deltas of token_count totals. */
  tc: Buckets;
  tcLast?: Usage;
  toolCalls: number;
  messages: number;
  lastAction?: ToolAction;
  lastCallId?: string;
  lastTool?: string;
  pending: Set<string>;
  ticks: number[];
  minutes: Map<number, number>;
  lastPrompt?: string;
  /** spawn_agent task name -> call id (links spawn cards to child agents). */
  spawns: Map<string, string>;
}

function newTrack(id: string, file: string, archived: boolean): ThreadTrack {
  return {
    id,
    file,
    archived,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    openTurns: new Set(),
    turns: 0,
    rec: newBuckets(),
    recSeen: new Set(),
    tc: newBuckets(),
    toolCalls: 0,
    messages: 0,
    pending: new Set(),
    ticks: [],
    minutes: new Map(),
    spawns: new Map(),
  };
}

const FULL_SCAN_MS = 15_000;
const MAX_TICKS_KEPT = 20_000;

const KIND_LABEL: Record<ThreadKind, string> = { desktop: "Codex Desktop", cli: "CLI", exec: "exec", subagent: "alt ajan", other: "Codex" };

export class CodexProvider extends EventEmitter implements Provider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;
  readonly home: string;
  private readonly recentMs: number;
  private readonly stallMs: number;
  private readonly liveMs: number;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private readonly useDb: boolean;
  private readonly now: () => number;
  private readonly userHome: string;

  private tracks = new Map<string, ThreadTrack>();
  /** Effective parent / children after the last organize(). */
  private parentOf = new Map<string, string>();
  private childrenOf = new Map<string, string[]>();
  private lastFull = 0;
  private needFull = false;
  private scanning = false;
  private rescan = false;
  private timer: NodeJS.Timeout | undefined;
  private kickTimer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private lastSignature = "";
  private dbState: "ok" | "missing" | "error" | "off" = "missing";
  private dbName: string | undefined;
  private skipped = 0;
  loading = true;

  constructor(opts: CodexOptions) {
    super();
    this.home = opts.codexHome;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.stallMs = opts.stallMs ?? 10 * 60 * 1000;
    this.liveMs = opts.liveMs ?? 2 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 2000;
    this.useWatch = opts.watch ?? true;
    this.useDb = opts.useDb ?? true;
    this.now = opts.now ?? Date.now;
    this.userHome = opts.userHome ?? homedir();
    if (!this.useDb) this.dbState = "off";
  }

  private get sessionsDir(): string {
    return join(this.home, "sessions");
  }
  private get archivedDir(): string {
    return join(this.home, "archived_sessions");
  }
  /** Only rollout files inside these two trees are ever opened. */
  private get roots(): string[] {
    return [this.sessionsDir, this.archivedDir];
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  onChange(fn: (sessionIds: string[]) => void): void {
    this.on("change", fn);
  }

  start(): void {
    void this.scan(true);
    this.timer = setInterval(() => void this.scan(false), this.pollMs);
    this.timer.unref?.();
    if (this.useWatch) {
      try {
        const w = watch(this.sessionsDir, { recursive: true, persistent: false }, (_ev, name) => {
          if (!name) return;
          const id = rolloutThreadId(basename(String(name)));
          if (!id) return;
          if (!this.tracks.has(id)) this.needFull = true;
          this.kick();
        });
        w.on("error", () => undefined);
        this.watchers.push(w);
      } catch {
        // Watching is an optimisation; polling still works.
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.scan(false);
    }, 250);
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
      const doFull = full || this.needFull || now - this.lastFull > FULL_SCAN_MS;
      if (doFull) {
        this.needFull = false;
        await this.discover(now);
        this.lastFull = now;
      }
      for (const t of this.tracks.values()) {
        const active = now - t.mtimeMs <= this.stallMs || t.offset === 0;
        if (!doFull && !active) continue;
        if (await this.advance(t)) changed.add(this.sessionIdOf(t.id));
      }
      this.organize();
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

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.runningAgents}|${s.agentCount}|${s.totalTokens}|${s.lastActivityAt}`)
      .join("\n");
  }

  private async discover(now: number): Promise<void> {
    const since = now - this.recentMs;
    let rows: Map<string, ThreadRow> | undefined;
    let edges: Array<{ parent: string; child: string; status?: string }> = [];

    if (this.useDb) {
      this.dbName = await this.findStateDb();
      if (!this.dbName) this.dbState = "missing";
      else {
        try {
          const snap = await readIndex(join(this.home, this.dbName), since);
          rows = snap.threads;
          edges = snap.edges;
          this.dbState = "ok";
        } catch {
          this.dbState = "error";
        }
      }
    }

    let skipped = 0;
    if (rows) {
      for (const row of rows.values()) {
        const file = await this.resolveRollout(row.rolloutPath);
        if (!file) {
          skipped++;
          continue;
        }
        const t = this.ensureTrack(row.id, file.path, row.archived || file.archived);
        t.row = row;
      }
      for (const e of edges) {
        const t = this.tracks.get(e.child);
        if (t) {
          t.edgeParent = e.parent;
          if (e.status) t.edgeStatus = e.status;
        }
      }
    }

    // Recent date dirs (both with and without the index: new threads show up here first).
    for (const dir of this.recentDateDirs(now)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const id = rolloutThreadId(n);
        if (!id || this.tracks.has(id)) continue;
        const p = join(dir, n);
        if (!safeToRead(p, this.roots)) continue;
        try {
          const st = await stat(p);
          if (st.mtimeMs >= since) this.ensureTrack(id, p, false);
        } catch {
          // vanished
        }
      }
    }
    // Without the index, archived rollouts only come from their flat dir (recent ones only).
    if (!rows) {
      let names: string[] = [];
      try {
        names = await readdir(this.archivedDir);
      } catch {
        names = [];
      }
      for (const n of names) {
        const id = rolloutThreadId(n);
        if (!id || this.tracks.has(id)) continue;
        const p = join(this.archivedDir, n);
        if (!safeToRead(p, this.roots)) continue;
        try {
          const st = await stat(p);
          if (st.mtimeMs >= since) this.ensureTrack(id, p, true);
        } catch {
          // vanished
        }
      }
    }
    this.skipped = skipped;
  }

  private async findStateDb(): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(this.home);
    } catch {
      return undefined;
    }
    let best: { n: string; v: number } | undefined;
    for (const n of names) {
      const v = stateDbVersion(n);
      if (v !== undefined && (!best || v > best.v)) best = { n, v };
    }
    return best?.n;
  }

  /** An index row's rollout path, if it is a rollout inside our roots (else undefined). */
  private async resolveRollout(p: string): Promise<{ path: string; archived: boolean } | undefined> {
    if (!rolloutThreadId(basename(p))) return undefined;
    const candidates = [p, join(this.archivedDir, basename(p))];
    for (const c of candidates) {
      if (!safeToRead(c, this.roots)) continue;
      try {
        await stat(c);
        return { path: c, archived: c.startsWith(this.archivedDir) };
      } catch {
        // try next
      }
    }
    return undefined;
  }

  /** `sessions/YYYY/MM/DD` for every calendar day (local and UTC) touching the window. */
  private recentDateDirs(now: number): string[] {
    const out = new Set<string>();
    const pad = (n: number) => String(n).padStart(2, "0");
    for (let t = now - this.recentMs - 86400_000; t <= now + 86400_000; t += 3600_000 * 6) {
      const d = new Date(t);
      out.add(join(this.sessionsDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
      out.add(join(this.sessionsDir, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
    }
    return [...out];
  }

  private ensureTrack(id: string, file: string, archived: boolean): ThreadTrack {
    let t = this.tracks.get(id);
    if (!t) {
      t = newTrack(id, file, archived);
      this.tracks.set(id, t);
    } else if (t.file !== file) {
      // Moved (e.g. archived): re-read from the start of the new file.
      const fresh = newTrack(id, file, archived);
      fresh.row = t.row;
      Object.assign(t, fresh);
    } else t.archived = archived;
    return t;
  }

  private async advance(t: ThreadTrack): Promise<boolean> {
    if (!safeToRead(t.file, this.roots)) return false;
    let st;
    try {
      st = await stat(t.file);
    } catch {
      return false;
    }
    t.mtimeMs = st.mtimeMs;
    if (st.size === t.offset) {
      t.size = st.size;
      return false;
    }
    let moved = false;
    for (;;) {
      const r = await readNewLines(t.file, t.offset);
      if (r.reset) {
        const fresh = newTrack(t.id, t.file, t.archived);
        fresh.row = t.row;
        if (t.edgeParent) fresh.edgeParent = t.edgeParent;
        if (t.edgeStatus) fresh.edgeStatus = t.edgeStatus;
        fresh.mtimeMs = t.mtimeMs;
        Object.assign(t, fresh);
      }
      for (const line of r.lines) this.ingest(t, line);
      if (r.lines.length > 0 || r.offset !== t.offset) moved = true;
      t.offset = r.offset;
      t.size = r.size;
      if (!r.more) break;
      await yieldToLoop();
    }
    return moved;
  }

  private ingest(t: ThreadTrack, line: string): void {
    const head = peekHead(line);
    const tsMs = head.ts ? Date.parse(head.ts) : NaN;
    if (Number.isFinite(tsMs)) {
      if (t.firstTs === undefined || tsMs < t.firstTs) t.firstTs = tsMs;
      if (t.lastTs === undefined || tsMs > t.lastTs) t.lastTs = tsMs;
      if (head.type === "response_item" && tsMs >= this.now() - ACTIVITY_KEEP_MIN * 60000) {
        const m = Math.floor(tsMs / 60000);
        t.minutes.set(m, (t.minutes.get(m) ?? 0) + 1);
      }
    }
    if (!worthParsing(line, head)) return;
    const e = parseLine(line);
    if (!e) return;
    const p = payloadOf(e);
    const day = localDay(Number.isFinite(tsMs) ? tsMs : this.now());
    switch (lineType(e)) {
      case "session_meta": {
        const m = sessionMeta(p);
        if (!m.id || m.id === t.id) {
          t.meta = m;
          if (m.cwd) t.cwd ??= m.cwd;
        }
        break;
      }
      case "turn_context": {
        const model = str(p["model"]);
        if (model) t.model = model;
        const cwd = str(p["cwd"]);
        if (cwd) t.cwd = cwd;
        const eff = str(p["effort"]) ?? str(p["reasoning_effort"]);
        if (eff) t.effort = eff;
        break;
      }
      case "token_usage_record": {
        const u = toUsage(p["usage"]);
        if (!u) break;
        const key = str(p["response_id"]) ?? `${str(p["turn_id"]) ?? ""}:${String(e["ordinal"] ?? line.length)}`;
        if (t.recSeen.has(key)) break;
        t.recSeen.add(key);
        addTo(t.rec, this.modelFor(t), day, u);
        break;
      }
      case "event_msg": {
        const pt = str(p["type"]);
        const turn = str(p["turn_id"]);
        if (pt === "task_started") {
          t.openTurns.add(turn ?? `o${String(e["ordinal"] ?? t.turns)}`);
          t.turns++;
        } else if (pt === "task_complete" || pt === "turn_aborted") {
          if (turn && t.openTurns.has(turn)) t.openTurns.delete(turn);
          else t.openTurns.clear();
          t.lastTurnEnd = pt === "task_complete" ? "complete" : "aborted";
          if (t.openTurns.size === 0) t.pending.clear();
        } else if (pt === "token_count") {
          const info = isObj(p["info"]) ? p["info"] : undefined;
          const total = info ? toUsage(info["total_token_usage"]) : undefined;
          if (total) {
            const prev = t.tcLast;
            const delta: Usage = prev
              ? { input: total.input - prev.input, output: total.output - prev.output, cacheRead: total.cacheRead - prev.cacheRead, cacheCreate: total.cacheCreate - prev.cacheCreate }
              : total;
            // A shrinking total means the counter restarted (e.g. after a compaction): count it anew.
            const d = delta.input < 0 || delta.output < 0 || delta.cacheRead < 0 || delta.cacheCreate < 0 ? total : delta;
            if (totalTokens(d) > 0) addTo(t.tc, this.modelFor(t), day, d);
            t.tcLast = total;
          }
        }
        break;
      }
      case "response_item": {
        const pt = str(p["type"]);
        if (pt === "function_call" || pt === "custom_tool_call") {
          const ci = describeCall(p);
          if (!ci) break;
          t.toolCalls++;
          t.lastAction = ci.action;
          t.lastTool = ci.summary ? `${ci.tool}: ${ci.summary}` : ci.tool;
          if (ci.callId) {
            t.lastCallId = ci.callId;
            t.pending.add(ci.callId);
            if (ci.action.kind === "agent" && ci.action.target && ci.tool.endsWith("spawn_agent")) t.spawns.set(ci.action.target, ci.callId);
          }
          if (Number.isFinite(tsMs) && t.ticks.length < MAX_TICKS_KEPT) t.ticks.push(tsMs);
        } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
          const cid = str(p["call_id"]);
          if (cid) t.pending.delete(cid);
        } else if (pt === "message") {
          if (p["role"] === "assistant") t.messages++;
          else {
            const up = userPrompt(p);
            if (up) t.lastPrompt = up;
          }
        }
        break;
      }
      default:
    }
  }

  private modelFor(t: ThreadTrack): string {
    return t.model ?? t.row?.model ?? "unknown";
  }

  // ---- tree -------------------------------------------------------------------------------------

  /** Recomputes effective parents (edges > index source > session_meta) and child lists. */
  private organize(): void {
    const parentOf = new Map<string, string>();
    for (const t of this.tracks.values()) {
      const p = t.edgeParent ?? t.row?.source.parentId ?? t.meta?.parentId;
      if (p && p !== t.id && this.tracks.has(p)) parentOf.set(t.id, p);
    }
    // Break cycles: walk up; a repeat detaches the node.
    for (const id of [...parentOf.keys()]) {
      const seen = new Set<string>([id]);
      let cur = parentOf.get(id);
      while (cur) {
        if (seen.has(cur)) {
          parentOf.delete(id);
          break;
        }
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    }
    const childrenOf = new Map<string, string[]>();
    for (const [c, p] of parentOf) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(c);
      childrenOf.set(p, arr);
    }
    this.parentOf = parentOf;
    this.childrenOf = childrenOf;
  }

  private rootOf(id: string): string {
    let cur = id;
    for (let i = 0; i < 64; i++) {
      const p = this.parentOf.get(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  }

  private sessionIdOf(threadId: string): string {
    return sessionKey(PROVIDER_ID, this.rootOf(threadId));
  }

  private descendants(id: string): ThreadTrack[] {
    const out: ThreadTrack[] = [];
    const walk = (x: string, depth: number) => {
      if (depth > 32) return;
      for (const c of this.childrenOf.get(x) ?? []) {
        const t = this.tracks.get(c);
        if (!t) continue;
        out.push(t);
        walk(c, depth + 1);
      }
    };
    walk(id, 0);
    return out;
  }

  // ---- state -------------------------------------------------------------------------------------

  private lastActivity(t: ThreadTrack): number {
    return Math.max(t.lastTs ?? 0, t.mtimeMs);
  }

  private state(t: ThreadTrack): AgentState {
    const age = this.now() - t.mtimeMs;
    if (!t.archived && t.openTurns.size > 0 && age <= this.stallMs) return "running";
    if (!t.archived && age <= this.liveMs) return "idle";
    return t.lastTurnEnd === "aborted" && t.openTurns.size === 0 ? "stopped" : "done";
  }

  private usageOf(t: ThreadTrack): Buckets {
    return t.recSeen.size > 0 ? t.rec : t.tc;
  }

  private costOf(byModel: Map<string, Usage>): { cost: number; partial: boolean } {
    let cost = 0;
    let partial = false;
    for (const [m, u] of byModel) {
      if (totalTokens(u) === 0) continue;
      const c = openAiCostUsd(m, u);
      if (c === undefined) partial = true;
      else cost += c;
    }
    return { cost, partial };
  }

  // ---- queries ------------------------------------------------------------------------------------

  isSessionId(id: string): boolean {
    return isThreadId(id);
  }

  private roots_(): ThreadTrack[] {
    return [...this.tracks.values()].filter((t) => !this.parentOf.has(t.id));
  }

  listSessions(): SessionSummary[] {
    return this.roots_().map((t) => this.summarize(t));
  }

  private threadName(t: ThreadTrack): string {
    const r = t.row;
    return cleanTitle(r?.title) ?? cleanTitle(r?.firstUserMessage) ?? (t.lastPrompt ? cleanTitle(t.lastPrompt) : undefined) ?? r?.nickname ?? t.meta?.nickname ?? t.id.slice(0, 8);
  }

  private summarize(root: ThreadTrack): SessionSummary {
    const now = this.now();
    const tree = [root, ...this.descendants(root.id)];
    const usage = emptyUsage();
    const byModel = new Map<string, Usage>();
    const minutes = new Map<number, number>();
    let running = 0;
    let firstTs: number | undefined;
    let lastAct = 0;
    for (const t of tree) {
      const b = this.usageOf(t);
      addUsage(usage, b.usage);
      for (const [m, u] of b.byModel) addUsage(bucket(byModel, m), u);
      for (const [m, c] of t.minutes) minutes.set(m, (minutes.get(m) ?? 0) + c);
      if (t !== root && this.state(t) === "running") running++;
      if (t.firstTs !== undefined && (firstTs === undefined || t.firstTs < firstTs)) firstTs = t.firstTs;
      lastAct = Math.max(lastAct, this.lastActivity(t));
    }
    const rootState = this.state(root);
    const live = rootState === "running" || rootState === "idle" || running > 0;
    const { cost, partial } = this.costOf(byModel);
    const kind = root.row?.source.kind ?? root.meta?.source.kind ?? "other";
    const cwd = root.cwd ?? root.row?.cwd ?? root.meta?.cwd ?? "";
    const sum: SessionSummary = {
      id: sessionKey(PROVIDER_ID, root.id),
      provider: PROVIDER_ID,
      projectDir: maskSecrets(cwd),
      cwd: maskSecrets(cwd),
      live,
      name: maskSecrets(this.threadName(root)),
      lastActivityAt: lastAct,
      hasTranscript: true,
      agentCount: tree.length - 1,
      runningAgents: running,
      usage,
      totalTokens: totalTokens(usage),
      costUsd: cost,
      activity: activityBuckets(minutes, now),
      kind,
      entrypoint: root.row?.originator ?? root.meta?.originator ?? KIND_LABEL[kind],
    };
    if (partial) sum.costPartial = true;
    if (live) {
      sum.status = rootState === "running" ? "busy" : "idle";
      const started = root.row?.createdAt ?? root.meta?.startedAt ?? root.firstTs;
      if (started !== undefined) sum.startedAt = started;
    }
    const version = root.row?.cliVersion ?? root.meta?.cliVersion;
    if (version) sum.version = version;
    if (firstTs !== undefined) sum.firstActivityAt = firstTs;
    if (root.row?.gitBranch) sum.gitBranch = maskSecrets(root.row.gitBranch);
    const model = root.model ?? root.row?.model;
    if (model) sum.model = model;
    if (root.lastPrompt) sum.lastPrompt = root.lastPrompt;
    return sum;
  }

  getSession(nativeId: string): SessionDetail | undefined {
    const root = this.tracks.get(nativeId.toLowerCase());
    if (!root || this.parentOf.has(root.id)) return undefined;
    const sum = this.summarize(root);
    const tree = this.node(root, root, 0);
    const usageByModel: Record<string, Usage> = {};
    const usageSubagents = emptyUsage();
    for (const t of [root, ...this.descendants(root.id)]) {
      const b = this.usageOf(t);
      for (const [m, u] of b.byModel) addUsage((usageByModel[m] ??= emptyUsage()), u);
      if (t !== root) addUsage(usageSubagents, b.usage);
    }
    const costByModel: Record<string, number | null> = {};
    for (const [m, u] of Object.entries(usageByModel)) costByModel[m] = openAiCostUsd(m, u) ?? null;
    return { ...sum, tree, usageByModel, costByModel, usageMain: { ...this.usageOf(root).usage }, usageSubagents };
  }

  private node(t: ThreadTrack, root: ThreadTrack, depth: number): AgentNode {
    const isMain = t === root;
    const now = this.now();
    const state = this.state(t);
    const b = this.usageOf(t);
    const { cost, partial } = this.costOf(b.byModel);
    const startedAt = t.firstTs ?? t.row?.createdAt;
    const lastActivityAt = this.lastActivity(t) || undefined;
    const end = state === "running" || state === "idle" ? now : (lastActivityAt ?? now);
    const nick = t.row?.nickname ?? t.meta?.nickname;
    const path = t.row?.agentPath ?? t.meta?.agentPath;
    const task = path ? path.split("/").filter(Boolean).pop() : undefined;
    const parentKey = isMain ? null : this.parentOf.get(t.id) === root.id ? "main" : (this.parentOf.get(t.id) ?? "main");
    const node: AgentNode = {
      key: isMain ? "main" : t.id,
      provider: PROVIDER_ID,
      label: isMain ? maskSecrets(this.threadName(t)) : maskSecrets(task ?? nick ?? `ajan ${t.id.slice(0, 8)}`),
      agentType: isMain ? "main" : maskSecrets(t.row?.role ?? nick ?? "alt ajan"),
      mode: isMain ? "main" : "unknown",
      state,
      durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
      usage: { ...b.usage },
      totalTokens: totalTokens(b.usage),
      messages: t.messages,
      toolCalls: t.toolCalls,
      ticks: tickOffsets(t.ticks, startedAt),
      costUsd: cost,
      parentKey,
      children: [],
    };
    if (partial) node.costPartial = true;
    const model = t.model ?? t.row?.model;
    if (model) node.model = model;
    if (startedAt !== undefined) node.startedAt = startedAt;
    if (lastActivityAt !== undefined) node.lastActivityAt = lastActivityAt;
    if (state !== "running" && state !== "idle" && lastActivityAt !== undefined) node.endedAt = lastActivityAt;
    // The current action only while its call is still waiting for output.
    if (state === "running" && t.lastAction && t.lastCallId && t.pending.has(t.lastCallId)) {
      node.lastAction = t.lastAction;
      if (t.lastTool) node.lastTool = maskSecrets(t.lastTool);
    }
    if (state === "stopped") node.endReason = "Tur iptal edildi";
    const depthV = t.row?.source.depth ?? t.meta?.source.depth;
    if (!isMain && depthV !== undefined) node.spawnDepth = depthV;
    if (!isMain && task) {
      const parent = this.tracks.get(this.parentOf.get(t.id) ?? "");
      const call = parent?.spawns.get(task);
      if (call) node.toolUseId = call;
    }
    const kids = (this.childrenOf.get(t.id) ?? []).map((c) => this.tracks.get(c)).filter((x): x is ThreadTrack => x !== undefined);
    if (depth < 32) node.children = kids.map((k) => this.node(k, root, depth + 1)).sort((x, y) => (x.startedAt ?? Infinity) - (y.startedAt ?? Infinity));
    return node;
  }

  machine(): MachineSummary {
    const now = this.now();
    const today = localDay(now);
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: 0, costToday: 0 };
    for (const s of this.listSessions()) if (s.live) out.liveSessions++;
    for (const t of this.tracks.values()) {
      for (const [k, u] of this.usageOf(t).dayModel) {
        const bar = k.indexOf("|");
        if (k.slice(0, bar) !== today) continue;
        out.outputToday += u.output;
        out.costToday += openAiCostUsd(k.slice(bar + 1), u) ?? 0;
      }
      const st = this.state(t);
      if (st === "running") out.runningAgents++;
      else if (this.parentOf.has(t.id) && (st === "done" || st === "stopped") && t.lastTs !== undefined && localDay(t.lastTs) === today) out.finishedToday++;
    }
    return out;
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    let last = 0;
    const models = new Set<string>();
    for (const t of this.tracks.values()) {
      last = Math.max(last, this.lastActivity(t));
      for (const m of this.usageOf(t).byModel.keys()) models.add(m);
    }
    const unpriced = [...models].filter((m) => m !== "unknown" && !openAiPrice(m));
    const seenVerified = [...models].filter((m) => m !== "unknown" && openAiPrice(m)?.verified === true).sort();
    const seenEstimated = [...models].filter((m) => m !== "unknown" && openAiPrice(m)?.verified === false).sort();
    const notes = [
      "Canlılık tahmini: açık tur (task_started → task_complete) + rollout değişimi (≤10 dk çalışıyor, ≤2 dk boşta)",
      this.dbState === "ok"
        ? `Dizin: ${this.dbName ?? "state.sqlite"} (salt okunur)`
        : this.dbState === "off"
          ? "Dizin kapalı: yalnızca rollout taraması"
          : `Dizin okunamadı (${this.dbState === "missing" ? "state_*.sqlite yok" : "hata"}); yalnızca rollout taraması`,
      codexPricingNote({ verified: seenVerified, estimated: seenEstimated }),
      "Biçim belgelenmemiş ve hızla değişiyor; savunmacı ayrıştırma",
    ];
    if (unpriced.length > 0) notes.push(`Fiyatı bilinmeyen model: ${unpriced.slice(0, 4).join(", ")} (maliyet —)`);
    if (this.skipped > 0) notes.push(`${this.skipped} dizin kaydı atlandı (rollout yok ya da izin dışı yol)`);
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: "CX",
      installed: existsSync(this.home),
      dataFound: this.tracks.size > 0 || existsSync(this.sessionsDir),
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: true, tokens: true, tools: true, subagents: true, cost: [...models].some((m) => openAiPrice(m) !== undefined) },
      notes,
      home: displayHome(this.home, this.userHome),
    };
    if (last > 0) st.lastActivityAt = last;
    return st;
  }

  // ---- events ------------------------------------------------------------------------------------

  private fileFor(nativeId: string, agentKey: string): string | undefined {
    const root = this.tracks.get(nativeId.toLowerCase());
    if (!root || this.parentOf.has(root.id)) return undefined;
    if (agentKey === "main") return root.file;
    const t = this.tracks.get(agentKey.toLowerCase());
    if (!t || this.rootOf(t.id) !== root.id) return undefined;
    return t.file;
  }

  async readEvents(nativeId: string, agentKey: string, opts: EventQuery): Promise<EventsResult | undefined> {
    const file = this.fileFor(nativeId, agentKey);
    if (!file || !safeToRead(file, this.roots)) return undefined;

    if (opts.after === undefined) {
      const want = Math.max(1, Math.min(opts.tail ?? 150, 1000));
      let window = 512 * 1024;
      for (;;) {
        const t = await readTailLines(file, window, opts.before);
        const parsed = linesToEvents(t.lines, t.start);
        if (parsed.length >= want || t.complete || window >= 64 * 1024 * 1024) {
          let from = Math.max(0, parsed.length - want);
          while (from > 0 && parsed[from - 1]?.lineStart === parsed[from]?.lineStart) from--;
          const kept = parsed.slice(from);
          const start = from === 0 ? t.start : (kept[0]?.lineStart ?? t.start);
          const truncated = start > 0 && (!t.complete || from > 0);
          return { events: kept.map((p) => p.ev), cursor: t.offset, start, truncated, reset: false };
        }
        window *= 4;
      }
    }

    const r = await readNewLines(file, opts.after, 4 * 1024 * 1024);
    let events = linesToEvents(r.lines, r.reset ? 0 : opts.after).map((p) => p.ev);
    let truncated = false;
    if (events.length > 500) {
      events = events.slice(-500);
      truncated = true;
    }
    return { events, cursor: r.offset, start: opts.after, truncated: truncated || r.more, reset: r.reset };
  }
}

/** Line types that can produce events (everything else, often huge, is skipped unparsed). */
function eventWorthy(line: string): boolean {
  const h = peekHead(line);
  if (h.type === "response_item") return h.ptype !== undefined || line.length <= 64 * 1024;
  if (h.type === "event_msg") return h.ptype === "task_complete" || h.ptype === "turn_aborted" || h.ptype === "thread_goal_updated" || h.ptype === undefined;
  return h.type === "compacted" || h.type === undefined;
}

/** Events with the byte offset of their line (the offset doubles as the stable event id). */
function linesToEvents(lines: string[], base: number): Array<{ ev: StreamEvent; lineStart: number }> {
  const out: Array<{ ev: StreamEvent; lineStart: number }> = [];
  let off = base;
  for (const line of lines) {
    const lineStart = off;
    off += Buffer.byteLength(line, "utf8") + 1;
    if (!eventWorthy(line)) continue;
    const e = parseLine(line);
    if (!e) continue;

    for (const ev of toEvents(e, `b${lineStart}`)) out.push({ ev, lineStart });
  }
  return out;
}
