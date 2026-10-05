/**
 * bionic/provider.ts -- Bionic (Element Labs' LM Studio based desktop app) sessions under
 * `~/.lmstudio/apps/bionic/projects/`. Strictly read-only.
 *
 * Discovery: every `projects/<uuid>/` with a `project.json` (project name) and an
 * `.internal/ng-sessions.sqlite`. Each pass opens that DB read-only, reads the `sessions` table, and
 * closes it again; the chat entries of a session are re-read only when its `updated_timestamp` or
 * committed head changed (cached analysis, no entry content is kept).
 *
 * Mapping: a session without a parent is a session in the list; sessions with `parent_session_id` (or
 * linked by a `subSessionReference` entry) are agents nested under it, recursively. Transient
 * sessions (the sub-sessions, approval reviewers) are never listed on their own unless live.
 *
 * Tokens: Bionic stores none. `contextEstimation` is a context-size estimate and is shown as
 * "bağlam ~N token" metadata, never as usage. No cost.
 *
 * Live heuristic (no processes are inspected; `updated_timestamp` + the last entry decide):
 *   running  -- updated within 2 min AND the newest significant entry is a user message, a tool result
 *               or an assistant tool call (an open turn: no turnSummary / final answer after it);
 *   idle     -- otherwise, updated within 10 min;
 *   done     -- otherwise (`failed` when the chain ends in an error entry, `stopped` when interrupted).
 * A session is live when its main session is running/idle or any of its agents is running.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { maskSecrets } from "../../mask.js";
import { ACTIVITY_KEEP_MIN, activityBuckets, clipLine, displayHome, emptyUsage, localDay, sessionKey, tickOffsets } from "../common.js";
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
} from "../types.js";
import { closeQuietly, openReadOnly, readChain, readSessions, type SessionRow } from "./db.js";
import { allowedBionicFile, analyzeChain, isProjectId, isSessionId, parseProjectName, parseSessionConfig, toEvents, type Analysis, type SessionConfig } from "./format.js";

export const PROVIDER_ID = "bionic";
export const PROVIDER_LABEL = "Bionic";

export interface BionicOptions {
  /** Bionic home; default `$BIONIC_HOME` or `~/.lmstudio/apps/bionic`. */
  bionicHome: string;
  /** Sessions updated within this window are listed. Default 24h. */
  recentMs?: number;
  /** An open turn updated within this window is "running". Default 2 min. */
  liveMs?: number;
  /** A session updated within this window is "idle" (live). Default 10 min. */
  idleMs?: number;
  pollMs?: number;
  now?: () => number;
  userHome?: string;
}

interface Rec {
  id: string;
  projectId: string;
  row: SessionRow;
  cfg: SessionConfig;
  an?: Analysis;
  parent?: string;
  children: string[];
  /** Title of the sub-session reference in its parent, when it has one. */
  refTitle?: string;
  inScope: boolean;
}

interface ProjectInfo {
  name?: string;
  dbFile: string;
}

const NOTE_CAPS = "yerel model; token/maliyet tutulmuyor";

export class BionicProvider extends EventEmitter implements Provider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;
  readonly home: string;
  private readonly recentMs: number;
  private readonly liveMs: number;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly userHome: string;

  private recs = new Map<string, Rec>();
  private projects = new Map<string, ProjectInfo>();
  private cfgCache = new Map<string, { key: string; cfg: SessionConfig }>();
  private anCache = new Map<string, { key: string; an: Analysis }>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private rescan = false;
  private lastSignature = "";
  private totalSessions = 0;
  private lastAny = 0;
  private dbErrors = 0;
  private sqliteMissing = false;
  loading = true;

  constructor(opts: BionicOptions) {
    super();
    this.home = opts.bionicHome;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.liveMs = opts.liveMs ?? 2 * 60 * 1000;
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 3000;
    this.now = opts.now ?? Date.now;
    this.userHome = opts.userHome ?? homedir();
  }

  private get projectsDir(): string {
    return join(this.home, "projects");
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

  // ---- scanning ----------------------------------------------------------------------------

  async scan(_full = false): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    const before = new Map<string, string>();
    for (const r of this.recs.values()) before.set(r.id, this.fingerprint(r));
    try {
      await this.readAll(this.now());
    } finally {
      this.scanning = false;
      this.loading = false;
    }
    const changed = new Set<string>();
    for (const r of this.recs.values()) if (before.get(r.id) !== this.fingerprint(r)) changed.add(sessionKey(PROVIDER_ID, this.rootOf(r).id));
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

  private fingerprint(r: Rec): string {
    return `${r.row.updated}|${r.row.head ?? ""}|${this.state(r)}`;
  }

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.runningAgents}|${s.agentCount}|${s.lastActivityAt}`)
      .join("\n");
  }

  /** One full pass: every project DB is opened, read and closed in turn. */
  private async readAll(now: number): Promise<void> {
    const recs = new Map<string, Rec>();
    const projects = new Map<string, ProjectInfo>();
    let total = 0;
    let lastAny = 0;
    let errors = 0;
    let names: string[] = [];
    try {
      names = await readdir(this.projectsDir);
    } catch {
      names = [];
    }
    const seenKeys = new Set<string>();
    for (const name of names.filter(isProjectId).sort()) {
      const pj = join(this.projectsDir, name, "project.json");
      const dbFile = join(this.projectsDir, name, ".internal", "ng-sessions.sqlite");
      if (!allowedBionicFile(dbFile, this.projectsDir) || !existsSync(dbFile)) continue;
      const info: ProjectInfo = { dbFile };
      if (allowedBionicFile(pj, this.projectsDir)) {
        try {
          const n = parseProjectName(await readFile(pj, "utf8"));
          if (n) info.name = n;
        } catch {
          // project.json is optional decoration.
        }
      }
      projects.set(name, info);
      const db = await openReadOnly(dbFile);
      if (!db) {
        errors++;
        continue;
      }
      try {
        const rows = readSessions(db);
        const local = new Map<string, Rec>();
        for (const row of rows) {
          total++;
          lastAny = Math.max(lastAny, row.updated);
          const id = row.id.toLowerCase();
          const key = `${row.updated}|${row.head ?? ""}`;
          let cfg = this.cfgCache.get(id);
          if (!cfg || cfg.key !== key) {
            cfg = { key, cfg: parseSessionConfig(row.sessionJson) };
            this.cfgCache.set(id, cfg);
          }
          const rec: Rec = { id, projectId: name, row, cfg: cfg.cfg, children: [], inScope: false };
          if (row.parent && row.parent.toLowerCase() !== id) rec.parent = row.parent.toLowerCase();
          local.set(id, rec);
        }
        for (const r of local.values()) {
          if (r.parent && !local.has(r.parent)) delete r.parent;
          if (r.parent) local.get(r.parent)?.children.push(r.id);
        }
        // Scope: trees whose newest update is inside the recent window (never sessions without entries).
        const cutoff = now - this.recentMs;
        for (const r of local.values()) {
          if (!r.row.head || r.row.temporary) continue;
          let top = r;
          for (let i = 0; i < 32 && top.parent; i++) top = local.get(top.parent) ?? top;
          if (this.treeUpdated(top, local) >= cutoff) r.inScope = true;
        }
        // Chat entries only for sessions in scope whose head/update changed.
        for (const r of local.values()) {
          if (!r.inScope || !r.row.head) continue;
          const key = `${r.row.updated}|${r.row.head}`;
          seenKeys.add(r.id);
          const hit = this.anCache.get(r.id);
          if (hit && hit.key === key) r.an = hit.an;
          else {
            try {
              r.an = analyzeChain(readChain(db, r.row.head), now);
              this.anCache.set(r.id, { key, an: r.an });
            } catch {
              errors++;
            }
          }
        }
        // Sub-session references link children whose parent column is empty.
        for (const r of local.values()) {
          for (const ref of r.an?.subs ?? []) {
            const c = local.get(ref.sessionId.toLowerCase());
            if (!c || c === r) continue;
            if (ref.title) c.refTitle = ref.title;
            if (!c.parent && this.rootIdOf(r, local) !== c.id) {
              c.parent = r.id;
              r.children.push(c.id);
            }
          }
        }
        for (const [id, r] of local) recs.set(id, r);
      } catch {
        errors++;
      } finally {
        closeQuietly(db);
      }
      await yieldToLoop();
    }
    for (const id of [...this.anCache.keys()]) if (!seenKeys.has(id)) this.anCache.delete(id);
    for (const id of [...this.cfgCache.keys()]) if (!recs.has(id)) this.cfgCache.delete(id);
    this.recs = recs;
    this.projects = projects;
    this.totalSessions = total;
    this.lastAny = lastAny;
    this.dbErrors = errors;
    this.sqliteMissing = projects.size > 0 && errors > 0 && recs.size === 0;
  }

  private treeUpdated(r: Rec, all: Map<string, Rec>, depth = 0): number {
    let m = r.row.updated;
    if (depth < 32) for (const c of r.children) {
      const k = all.get(c);
      if (k) m = Math.max(m, this.treeUpdated(k, all, depth + 1));
    }
    return m;
  }

  private rootIdOf(r: Rec, all: Map<string, Rec>): string {
    let cur = r;
    for (let i = 0; i < 32 && cur.parent; i++) cur = all.get(cur.parent) ?? cur;
    return cur.id;
  }

  // ---- state -------------------------------------------------------------------------------

  private lastActivity(r: Rec): number {
    return Math.max(r.row.updated, r.an?.lastTs ?? 0);
  }

  private state(r: Rec): AgentState {
    if (!r.inScope) return "done";
    const age = this.now() - this.lastActivity(r);
    if (r.an?.openTurn && age <= this.liveMs) return "running";
    if (age <= this.idleMs) return "idle";
    if (r.an?.terminal === "error") return "failed";
    if (r.an?.terminal === "interrupted") return "stopped";
    return "done";
  }

  private rootOf(r: Rec): Rec {
    let cur = r;
    for (let i = 0; i < 32 && cur.parent; i++) cur = this.recs.get(cur.parent) ?? cur;
    return cur;
  }

  private descendants(r: Rec, depth = 0): Rec[] {
    if (depth > 32) return [];
    const out: Rec[] = [];
    for (const c of r.children) {
      const k = this.recs.get(c);
      if (k) out.push(k, ...this.descendants(k, depth + 1));
    }
    return out;
  }

  private isLive(root: Rec): boolean {
    const s = this.state(root);
    return s === "running" || s === "idle" || this.descendants(root).some((d) => this.state(d) === "running");
  }

  /** Listed sessions: in-scope roots; a transient root only while live. */
  private roots(): Rec[] {
    return [...this.recs.values()].filter((r) => !r.parent && r.inScope && (!r.row.transient || this.isLive(r)));
  }

  // ---- queries -----------------------------------------------------------------------------

  isSessionId(id: string): boolean {
    return isSessionId(id);
  }

  listSessions(): SessionSummary[] {
    return this.roots().map((r) => this.summarize(r));
  }

  private nameOf(r: Rec): string {
    return (
      clipLine(r.row.name ?? "", 120) ||
      clipLine(r.row.suggested ?? "", 120) ||
      clipLine(r.refTitle ?? "", 120) ||
      clipLine(r.an?.firstUser ?? "", 120) ||
      r.id.slice(0, 8)
    );
  }

  private ctxLabel(r: Rec): string | undefined {
    const n = r.an?.ctxTotal ?? r.cfg.ctxTotal;
    if (n === undefined || n <= 0) return undefined;
    const t = n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",")}k` : String(Math.round(n));
    return `bağlam ~${t} token`;
  }

  private summarize(root: Rec): SessionSummary {
    const now = this.now();
    const tree = [root, ...this.descendants(root)];
    const minutes = new Map<number, number>();
    let running = 0;
    let firstTs: number | undefined;
    let lastAct = 0;
    for (const t of tree) {
      for (const [m, c] of t.an?.minutes ?? []) if (now / 60000 - m < ACTIVITY_KEEP_MIN) minutes.set(m, (minutes.get(m) ?? 0) + c);
      if (t !== root && this.state(t) === "running") running++;
      const f = t.an?.firstTs;
      if (f !== undefined && (firstTs === undefined || f < firstTs)) firstTs = f;
      lastAct = Math.max(lastAct, this.lastActivity(t));
    }
    const rootState = this.state(root);
    const live = this.isLive(root);
    const cwd = maskSecrets(root.cfg.cwd ?? "");
    const project = this.projects.get(root.projectId)?.name;
    const entry = [project, this.ctxLabel(root)].filter((x): x is string => Boolean(x)).join(" · ");
    const sum: SessionSummary = {
      id: sessionKey(PROVIDER_ID, root.id),
      provider: PROVIDER_ID,
      projectDir: cwd || maskSecrets(project ?? ""),
      cwd,
      live,
      name: maskSecrets(this.nameOf(root)),
      lastActivityAt: lastAct,
      hasTranscript: true,
      agentCount: tree.length - 1,
      runningAgents: running,
      usage: emptyUsage(),
      totalTokens: 0,
      costUsd: 0,
      activity: activityBuckets(minutes, now),
    };
    if (entry) sum.entrypoint = maskSecrets(entry);
    if (live) {
      sum.status = rootState === "running" || running > 0 ? "busy" : "idle";
      if (root.an?.firstTs !== undefined) sum.startedAt = root.an.firstTs;
    }
    if (firstTs !== undefined) sum.firstActivityAt = firstTs;
    if (root.cfg.model) sum.model = maskSecrets(root.cfg.model);
    if (root.an?.lastPrompt) sum.lastPrompt = clipLine(root.an.lastPrompt, 300);
    return sum;
  }

  getSession(nativeId: string): SessionDetail | undefined {
    const root = this.recs.get(nativeId.toLowerCase());
    if (!root || !this.roots().includes(root)) return undefined;
    return { ...this.summarize(root), tree: this.node(root, root, 0), usageByModel: {}, costByModel: {}, usageMain: emptyUsage(), usageSubagents: emptyUsage() };
  }

  private node(r: Rec, root: Rec, depth: number): AgentNode {
    const isMain = r === root;
    const now = this.now();
    const state = this.state(r);
    const startedAt = r.an?.firstTs;
    const lastActivityAt = this.lastActivity(r) || undefined;
    const end = state === "running" || state === "idle" ? now : (lastActivityAt ?? now);
    const reviewer = r.row.companion?.endsWith("approvalReviewer") === true;
    const node: AgentNode = {
      key: isMain ? "main" : r.id,
      provider: PROVIDER_ID,
      label: maskSecrets(this.nameOf(r)),
      agentType: isMain ? "main" : reviewer ? "onay denetçisi" : "alt oturum",
      mode: isMain ? "main" : "unknown",
      state,
      durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
      usage: emptyUsage(),
      totalTokens: 0,
      messages: r.an?.messages ?? 0,
      toolCalls: r.an?.toolCalls ?? 0,
      ticks: tickOffsets(r.an?.ticks ?? [], startedAt),
      costUsd: 0,
      parentKey: isMain ? null : r.parent === root.id ? "main" : (r.parent ?? "main"),
      children: [],
    };
    if (r.cfg.model) node.model = maskSecrets(r.cfg.model);
    const meta: Record<string, string | number> = {};
    const project = this.projects.get(r.projectId)?.name;
    if (project) meta["Proje"] = maskSecrets(project);
    const ctx = this.ctxLabel(r);
    if (ctx) meta["Bağlam"] = ctx.replace(/^bağlam /, "");
    if (r.cfg.shellMode) meta["Shell modu"] = maskSecrets(r.cfg.shellMode);
    if (Object.keys(meta).length > 0) node.meta = meta;
    if (startedAt !== undefined) node.startedAt = startedAt;
    if (lastActivityAt !== undefined) node.lastActivityAt = lastActivityAt;
    if (state !== "running" && state !== "idle" && lastActivityAt !== undefined) node.endedAt = lastActivityAt;
    if (state === "running" && r.an?.lastAction && r.an.lastCallPending) {
      node.lastAction = r.an.lastAction;
      if (r.an.lastTool) node.lastTool = maskSecrets(r.an.lastTool);
    }
    if (state === "failed") node.endReason = clipLine(`Hata${r.an?.errorCode ? `: ${r.an.errorCode}` : ""}`, 160);
    if (state === "stopped") node.endReason = "Tur kesildi";
    if (depth < 32) {
      node.children = r.children
        .map((c) => this.recs.get(c))
        .filter((x): x is Rec => x !== undefined)
        .map((k) => this.node(k, root, depth + 1))
        .sort((x, y) => (x.startedAt ?? Infinity) - (y.startedAt ?? Infinity));
    }
    return node;
  }

  machine(): MachineSummary {
    const today = localDay(this.now());
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: 0, costToday: 0 };
    for (const root of this.roots()) if (this.isLive(root)) out.liveSessions++;
    for (const r of this.recs.values()) {
      if (!r.inScope) continue;
      const st = this.state(r);
      if (st === "running") out.runningAgents++;
      else if (r.parent && (st === "done" || st === "stopped" || st === "failed") && localDay(this.lastActivity(r)) === today) out.finishedToday++;
    }
    return out;
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    const notes = [
      NOTE_CAPS,
      "Bağlam ~N token yalnızca bağlam boyutu tahminidir, kullanım değildir",
      "Canlılık tahmini: açık tur + güncelleme zamanı (≤2 dk çalışıyor, ≤10 dk boşta)",
      `Salt okunur SQLite (${this.projects.size} proje); yalnızca project.json ve ng-sessions.sqlite okunur`,
      "Biçim belgelenmemiş; savunmacı ayrıştırma",
    ];
    if (this.sqliteMissing) notes.push("node:sqlite kullanılamıyor ya da veritabanları açılamadı");
    else if (this.dbErrors > 0) notes.push(`${this.dbErrors} veritabanı/oturum okunamadı`);
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: "BI",
      installed: existsSync(this.home),
      dataFound: this.totalSessions > 0,
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: true, tokens: false, tools: true, subagents: true, cost: false },
      notes,
      home: displayHome(this.home, this.userHome),
    };
    if (this.lastAny > 0) st.lastActivityAt = this.lastAny;
    return st;
  }

  // ---- events ------------------------------------------------------------------------------

  async readEvents(nativeId: string, agentKey: string, q: EventQuery): Promise<EventsResult | undefined> {
    const root = this.recs.get(nativeId.toLowerCase());
    if (!root || !this.roots().includes(root)) return undefined;
    let rec: Rec | undefined = root;
    if (agentKey !== "main") {
      rec = this.recs.get(agentKey.toLowerCase());
      if (!rec || this.rootOf(rec) !== root) return undefined;
    }
    const proj = this.projects.get(rec.projectId);
    if (!proj || !rec.row.head || !allowedBionicFile(proj.dbFile, this.projectsDir)) return undefined;
    const db = await openReadOnly(proj.dbFile);
    if (!db) return undefined;
    let all: StreamEvent[];
    try {
      all = readChain(db, rec.row.head).flatMap((e) => toEvents(e));
    } catch {
      return undefined;
    } finally {
      closeQuietly(db);
    }
    // Cursors are event counts: the chain only ever grows at its tail.
    const n = all.length;
    if (q.after === undefined) {
      const want = Math.max(1, Math.min(q.tail ?? 150, 1000));
      const end = q.before !== undefined ? Math.max(0, Math.min(q.before, n)) : n;
      const start = Math.max(0, end - want);
      return { events: all.slice(start, end), cursor: n, start, truncated: start > 0, reset: false };
    }
    if (q.after > n) {
      const start = Math.max(0, n - 500);
      return { events: all.slice(start), cursor: n, start, truncated: start > 0, reset: true };
    }
    let events = all.slice(q.after);
    let truncated = false;
    if (events.length > 500) {
      events = events.slice(-500);
      truncated = true;
    }
    return { events, cursor: n, start: q.after, truncated, reset: false };
  }
}
