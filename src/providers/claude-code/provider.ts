/**
 * claude-code/provider.ts -- discovers Claude Code sessions under a "claude home" (default ~/.claude),
 * tails their transcripts incrementally and keeps compact aggregates in memory. Strictly read-only.
 *
 * All knowledge of the on-disk format lives in ./format.ts; this file only orchestrates.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  addUsage,
  describeToolUses,
  emptyUsage,
  encodeCwd,
  entryInfo,
  extractAgentLinks,
  extractSpawns,
  extractTaskNotifications,
  isAgentId,
  isRegistryFileName,
  isSessionId,
  parseAgentMeta,
  parseAgentMetaName,
  parseAgentTranscriptName,
  parseCustomTitleFile,
  notificationOutcome,
  parseLine,
  parseRegistryFile,
  sessionMetaFromEntry,
  toEvents,
  toolUseTime,
  totalTokens,
  type AgentMeta,
  type ToolAction,
  type RegistryEntry,
  type SpawnInfo,
  type StreamEvent,
  type Usage,
} from "./format.js";
import { readNewLines, readTailLines } from "../../tail.js";
import { claudeCostOfModels, claudeCostUsd } from "../../pricing.js";
import { maskSecrets } from "../../mask.js";
import { ACTIVITY_KEEP_MIN, activityBuckets, displayHome, localDay, tickOffsets } from "../common.js";
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
} from "../types.js";

export const PROVIDER_ID = "claude-code";
export const PROVIDER_LABEL = "Claude Code";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AgentTrack {
  key: string;
  agentId: string | null;
  file: string;
  offset: number;
  size: number;
  mtimeMs: number;
  meta?: AgentMeta;
  metaTries: number;
  workflow?: string;
  usage: Usage;
  msgUsage: Map<string, { model: string; usage: Usage; day: string }>;
  byModel: Map<string, Usage>;
  /** Usage keyed by `<local day>|<model>` (for "today" counters). */
  dayModel: Map<string, Usage>;
  /** Epoch ms of every assistant line carrying a tool_use. */
  ticks: number[];
  lastAction?: ToolAction;
  firstTs?: number;
  lastTs?: number;
  lastRole?: "user" | "assistant";
  lastStop?: string | null;
  model?: string;
  messages: number;
  toolCalls: number;
  lastTool?: string;
}

interface SpawnRecord {
  ownerKey: string;
  info: SpawnInfo;
}

interface SessionTrack {
  id: string;
  projectDir: string;
  dirPath: string;
  mainFile: string;
  main: AgentTrack;
  agents: Map<string, AgentTrack>;
  spawns: Map<string, SpawnRecord>;
  agentToToolUse: Map<string, string>;
  /** Latest task-notification per task/agent id (arrives in the parent transcript). */
  notifs: Map<string, { status: string; ts: number; summary?: string }>;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  version?: string;
  entrypoint?: string;
  customTitle?: string;
  agentName?: string;
  lastPrompt?: string;
  titleFileTitle?: string;
  /** Transcript entries per epoch minute (recent window only). */
  minutes: Map<number, number>;
  subDirMtime: number;
  lastFullCheck: number;
  mtimeMs: number;
}

interface SessionIndexEntry {
  id: string;
  projectDir: string;
  dirPath: string;
  mainFile: string;
  mtimeMs: number;
}

function newAgent(key: string, agentId: string | null, file: string): AgentTrack {
  return {
    key,
    agentId,
    file,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    metaTries: 0,
    usage: emptyUsage(),
    msgUsage: new Map(),
    byModel: new Map(),
    dayModel: new Map(),
    ticks: [],
    messages: 0,
    toolCalls: 0,
  };
}

export interface ClaudeCodeOptions {
  /** Claude config dir; default `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeHome: string;
  /** Sessions whose transcript changed within this window are listed. Default 24h. */
  recentMs?: number;
  /** Idle agents older than this without a final answer are "stalled". Default 10 min. */
  stallMs?: number;
  /** Poll interval for active sessions. Default 2s. */
  pollMs?: number;
  /** Use fs.watch to trigger early scans. Default true. */
  watch?: boolean;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
}

export function defaultPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking only; it never delivers a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const ACTIVE_MS = 10 * 60 * 1000;
const FULL_SCAN_MS = 15 * 1000;
const NOTIFY_SLACK_MS = 5000;

export class ClaudeCodeProvider extends EventEmitter implements Provider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;
  readonly home: string;
  private readonly recentMs: number;
  private readonly stallMs: number;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;

  private sessions = new Map<string, SessionTrack>();
  private registry = new Map<string, RegistryEntry & { alive: boolean }>();
  private index = new Map<string, SessionIndexEntry>();
  private lastFull = 0;
  private scanning = false;
  private rescan = false;
  private timer: NodeJS.Timeout | undefined;
  private kickTimer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private lastSignature = "";
  /** True until the first full scan (and initial transcript load) completed. */
  loading = true;

  constructor(opts: ClaudeCodeOptions) {
    super();
    this.home = opts.claudeHome;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.stallMs = opts.stallMs ?? ACTIVE_MS;
    this.pollMs = opts.pollMs ?? 2000;
    this.useWatch = opts.watch ?? true;
    this.now = opts.now ?? Date.now;
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
  }

  onChange(fn: (sessionIds: string[]) => void): void {
    this.on("change", fn);
  }

  isSessionId(id: string): boolean {
    return isSessionId(id);
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    let last = 0;
    for (const s of sessions) last = Math.max(last, s.lastActivityAt);
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: "CC",
      installed: existsSync(this.home),
      dataFound: this.index.size > 0 || this.registry.size > 0,
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: true, tokens: true, tools: true, subagents: true, cost: true },
      notes: ["Canlılık: oturum kaydı + süreç kontrolü (kill -0)", "Biçim belgelenmemiş; savunmacı ayrıştırma"],
      home: displayHome(this.home, homedir()),
    };
    if (last > 0) st.lastActivityAt = last;
    return st;
  }

  get sessionsDir(): string {
    return join(this.home, "sessions");
  }
  get projectsDir(): string {
    return join(this.home, "projects");
  }

  // ---- lifecycle ---------------------------------------------------------

  start(): void {
    void this.scan(true);
    this.timer = setInterval(() => void this.scan(false), this.pollMs);
    this.timer.unref?.();
    if (this.useWatch) {
      for (const dir of [this.sessionsDir, this.projectsDir]) {
        try {
          const w = watch(dir, { recursive: true, persistent: false }, (_ev, name) => {
            if (name && name.endsWith(".key")) return; // never react to (or read) secret key files
            this.kick();
          });
          w.on("error", () => undefined);
          this.watchers.push(w);
        } catch {
          // Watching is an optimisation; polling still works.
        }
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

  // ---- scanning ------------------------------------------------------------

  /** One scan pass. `full` forces re-discovery of all sessions on disk. Safe to call concurrently. */
  async scan(full = false): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    const changed = new Set<string>();
    try {
      await this.readRegistry(changed);
      const now = this.now();
      const doFull = full || now - this.lastFull > FULL_SCAN_MS;
      if (doFull) {
        await this.discover();
        this.lastFull = now;
      }
      for (const entry of this.index.values()) {
        const live = this.registry.get(entry.id)?.alive === true;
        const recent = now - entry.mtimeMs <= this.recentMs;
        if (!live && !recent) continue;
        let s = this.sessions.get(entry.id);
        if (!s) {
          s = this.createSession(entry);
          this.sessions.set(entry.id, s);
          changed.add(s.id);
        }
        const active = live || now - s.mtimeMs <= ACTIVE_MS;
        if (doFull || active || now - s.lastFullCheck > FULL_SCAN_MS) {
          const moved = await this.refreshSession(s, doFull || active || s.lastFullCheck === 0);
          s.lastFullCheck = now;
          if (moved) changed.add(s.id);
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

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.runningAgents}|${s.agentCount}|${s.totalTokens}|${s.lastActivityAt}`)
      .join("\n");
  }

  private async readRegistry(changed: Set<string>): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.sessionsDir);
    } catch {
      names = [];
    }
    const next = new Map<string, RegistryEntry & { alive: boolean }>();
    for (const name of names) {
      if (!isRegistryFileName(name)) continue; // ignores *.key entirely
      let text: string;
      try {
        text = await readFile(join(this.sessionsDir, name), "utf8");
      } catch {
        continue;
      }
      const e = parseRegistryFile(text);
      if (!e) continue;
      const alive = this.pidAlive(e.pid);
      const prev = this.registry.get(e.sessionId);
      const cur = { ...e, alive };
      // Several registry files can point at one session; prefer an alive one.
      const existing = next.get(e.sessionId);
      if (existing?.alive && !alive) continue;
      next.set(e.sessionId, cur);
      if (!prev || prev.alive !== alive || prev.status !== e.status || prev.name !== e.name || prev.pid !== e.pid) {
        changed.add(e.sessionId);
      }
    }
    for (const id of this.registry.keys()) if (!next.has(id)) changed.add(id);
    this.registry = next;
  }

  private async discover(): Promise<void> {
    const index = new Map<string, SessionIndexEntry>();
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.projectsDir);
    } catch {
      dirs = [];
    }
    for (const projectDir of dirs) {
      const dirPath = join(this.projectsDir, projectDir);
      let names: string[];
      try {
        names = await readdir(dirPath);
      } catch {
        continue;
      }
      const jsonl = names.filter((n) => n.endsWith(".jsonl"));
      const stats = await Promise.all(
        jsonl.map(async (n) => {
          try {
            return { n, st: await stat(join(dirPath, n)) };
          } catch {
            return null;
          }
        }),
      );
      for (const r of stats) {
        if (!r) continue;
        const id = r.n.slice(0, -".jsonl".length);
        if (!isSessionId(id)) continue;
        const prev = index.get(id);
        if (prev && prev.mtimeMs >= r.st.mtimeMs) continue;
        index.set(id, { id, projectDir, dirPath, mainFile: join(dirPath, r.n), mtimeMs: r.st.mtimeMs });
      }
    }
    this.index = index;
  }

  private createSession(entry: SessionIndexEntry): SessionTrack {
    return {
      id: entry.id,
      projectDir: entry.projectDir,
      dirPath: entry.dirPath,
      mainFile: entry.mainFile,
      main: newAgent("main", null, entry.mainFile),
      agents: new Map(),
      spawns: new Map(),
      agentToToolUse: new Map(),
      notifs: new Map(),
      minutes: new Map(),
      subDirMtime: 0,
      lastFullCheck: 0,
      mtimeMs: entry.mtimeMs,
    };
  }

  /** Returns true if any tracked file advanced. */
  private async refreshSession(s: SessionTrack, listAgents: boolean): Promise<boolean> {
    let moved = false;
    if (await this.advance(s, s.main)) moved = true;
    s.mtimeMs = Math.max(s.mtimeMs, s.main.mtimeMs);

    const subRoot = join(s.dirPath, s.id, "subagents");
    let subMtime = 0;
    try {
      subMtime = (await stat(subRoot)).mtimeMs;
    } catch {
      subMtime = 0;
    }
    if (listAgents || subMtime !== s.subDirMtime) {
      s.subDirMtime = subMtime;
      if (subMtime > 0) await this.discoverAgents(s, subRoot);
    }
    for (const a of s.agents.values()) {
      if (a.metaTries < 3 && !a.meta) await this.loadMeta(a);
      if (await this.advance(s, a)) moved = true;
      s.mtimeMs = Math.max(s.mtimeMs, a.mtimeMs);
    }
    if (!s.titleFileTitle) {
      try {
        s.titleFileTitle = parseCustomTitleFile(await readFile(join(s.dirPath, s.id, "custom-title.json"), "utf8"));
      } catch {
        // optional file
      }
    }
    return moved;
  }

  private async discoverAgents(s: SessionTrack, root: string, workflow?: string, depth = 0): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.isDirectory()) {
        if (depth < 3) await this.discoverAgents(s, join(root, d.name), d.name === "workflows" ? workflow : (workflow ?? d.name), depth + 1);
        continue;
      }
      const id = parseAgentTranscriptName(d.name);
      if (!id || !isAgentId(id) || s.agents.has(id)) continue;
      const a = newAgent(id, id, join(root, d.name));
      if (workflow) a.workflow = workflow;
      s.agents.set(id, a);
    }
  }

  private async loadMeta(a: AgentTrack): Promise<void> {
    a.metaTries++;
    const metaName = basename(a.file).replace(/\.jsonl$/, ".meta.json");
    if (parseAgentMetaName(metaName) === null) return;
    try {
      const text = await readFile(join(dirname(a.file), metaName), "utf8");
      const m = parseAgentMeta(text);
      if (m) a.meta = m;
    } catch {
      // meta.json is optional
    }
  }

  /** Read newly appended lines of one transcript into the aggregates. */
  private async advance(s: SessionTrack, a: AgentTrack): Promise<boolean> {
    let st;
    try {
      st = await stat(a.file);
    } catch {
      return false;
    }
    a.mtimeMs = st.mtimeMs;
    if (st.size === a.offset) {
      a.size = st.size;
      return false;
    }
    let moved = false;
    for (;;) {
      const r = await readNewLines(a.file, a.offset);
      if (r.reset) this.resetAgent(s, a);
      for (const line of r.lines) this.ingest(s, a, line);
      if (r.lines.length > 0 || r.offset !== a.offset) moved = true;
      a.offset = r.offset;
      a.size = r.size;
      if (!r.more) break;
      await yieldToLoop();
    }
    return moved;
  }

  private resetAgent(s: SessionTrack, a: AgentTrack): void {
    const meta = a.meta;
    const fresh = newAgent(a.key, a.agentId, a.file);
    Object.assign(a, fresh);
    if (meta) a.meta = meta;
    if (a.key === "main") {
      s.spawns.clear();
      s.notifs.clear();
    }
  }

  private ingest(s: SessionTrack, a: AgentTrack, line: string): void {
    const e = parseLine(line);
    if (!e) return; // blank, partial or non-JSON: skip
    const info = entryInfo(e);

    const tsMs = info.timestamp ? Date.parse(info.timestamp) : NaN;
    if (Number.isFinite(tsMs)) {
      if (a.firstTs === undefined || tsMs < a.firstTs) a.firstTs = tsMs;
      if (a.lastTs === undefined || tsMs > a.lastTs) a.lastTs = tsMs;
      if ((info.type === "assistant" || info.type === "user") && tsMs >= this.now() - ACTIVITY_KEEP_MIN * 60000) {
        const m = Math.floor(tsMs / 60000);
        s.minutes.set(m, (s.minutes.get(m) ?? 0) + 1);
      }
    }
    const tt = toolUseTime(e);
    if (tt !== undefined) a.ticks.push(tt);

    if (a.key === "main") {
      if (info.cwd) s.cwd ??= info.cwd;
      if (info.gitBranch) s.gitBranch = info.gitBranch;
      if (info.slug) s.slug = info.slug;
      if (info.version) s.version = info.version;
      if (info.entrypoint) s.entrypoint = info.entrypoint;
      const sm = sessionMetaFromEntry(e);
      if (sm.customTitle) s.customTitle = sm.customTitle;
      if (sm.agentName) s.agentName = sm.agentName;
      if (sm.lastPrompt) s.lastPrompt = sm.lastPrompt;
    }

    for (const n of extractTaskNotifications(e)) {
      if (!n.status) continue;
      const ts = info.timestamp ? Date.parse(info.timestamp) : NaN;
      const prev = s.notifs.get(n.taskId);
      if (Number.isFinite(ts) && (!prev || ts >= prev.ts)) s.notifs.set(n.taskId, n.summary ? { status: n.status, ts, summary: n.summary } : { status: n.status, ts });
    }

    if ((info.type === "assistant" || info.type === "user") && info.role) {
      a.lastRole = info.role;
      a.lastStop = info.role === "assistant" ? (info.stopReason ?? null) : null;

      if (info.role === "assistant") {
        // One API message is written as several lines (one per content block) that repeat the same usage;
        // count each message id once, letting later lines overwrite earlier ones.
        const uuid = typeof e["uuid"] === "string" ? e["uuid"] : undefined;
        const key = info.messageId ?? (uuid ? `uuid:${uuid}` : undefined);
        if (info.usage && key && !info.isApiError) {
          const model = info.model ?? a.model ?? "unknown";
          const day = localDay(Number.isFinite(tsMs) ? tsMs : this.now());
          const prev = a.msgUsage.get(key);
          if (prev) {
            addUsage(a.usage, prev.usage, -1);
            addUsage(this.modelBucket(a, prev.model), prev.usage, -1);
            addUsage(this.dayBucket(a, prev.day, prev.model), prev.usage, -1);
          } else {
            a.messages++;
          }
          a.msgUsage.set(key, { model, usage: info.usage, day });
          addUsage(a.usage, info.usage);
          addUsage(this.modelBucket(a, model), info.usage);
          addUsage(this.dayBucket(a, day, model), info.usage);
        }
        if (info.model) a.model = info.model;
        const tools = describeToolUses(e);
        a.toolCalls += tools.count;
        if (tools.last) a.lastTool = tools.last;
        if (tools.action) a.lastAction = tools.action;
      }

      for (const sp of extractSpawns(e)) s.spawns.set(sp.toolUseId, { ownerKey: a.key, info: sp });
      for (const l of extractAgentLinks(e)) s.agentToToolUse.set(l.agentId, l.toolUseId);
    }
  }

  private modelBucket(a: AgentTrack, model: string): Usage {
    let b = a.byModel.get(model);
    if (!b) {
      b = emptyUsage();
      a.byModel.set(model, b);
    }
    return b;
  }

  private dayBucket(a: AgentTrack, day: string, model: string): Usage {
    const k = `${day}|${model}`;
    let b = a.dayModel.get(k);
    if (!b) {
      b = emptyUsage();
      a.dayModel.set(k, b);
    }
    return b;
  }

  // ---- queries -------------------------------------------------------------

  /** Machine-wide counters over all tracked sessions. */
  machine(): MachineSummary {
    const now = this.now();
    const today = localDay(now);
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: 0, costToday: 0 };
    for (const r of this.registry.values()) if (r.alive) out.liveSessions++;
    for (const s of this.sessions.values()) {
      for (const a of [s.main, ...s.agents.values()]) {
        for (const [k, u] of a.dayModel) {
          const bar = k.indexOf("|");
          if (k.slice(0, bar) !== today) continue;
          out.outputToday += u.output;
          out.costToday += claudeCostUsd(k.slice(bar + 1), u) ?? 0;
        }
        if (a.key === "main") continue;
        const st = this.agentState(s, a);
        if (st === "running") out.runningAgents++;
        else if ((st === "done" || st === "failed" || st === "stopped") && a.lastTs !== undefined && localDay(a.lastTs) === today) out.finishedToday++;
      }
      if (this.agentState(s, s.main) === "running") out.runningAgents++;
    }
    return out;
  }

  listSessions(): SessionSummary[] {
    const out: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const s of this.sessions.values()) {
      seen.add(s.id);
      out.push(this.summarize(s));
    }
    // Live sessions without a transcript on disk (yet).
    for (const r of this.registry.values()) {
      if (seen.has(r.sessionId) || !r.alive) continue;
      out.push(this.summarizeRegistryOnly(r));
    }
    return out.sort((a, b) => Number(b.live) - Number(a.live) || b.lastActivityAt - a.lastActivityAt);
  }

  getSession(id: string): SessionDetail | undefined {
    const s = this.sessions.get(id);
    if (!s) {
      const r = this.registry.get(id);
      if (!r?.alive) return undefined;
      const sum = this.summarizeRegistryOnly(r);
      return {
        ...sum,
        tree: emptyRoot(sum.name),
        usageByModel: {},
        costByModel: {},
        usageMain: emptyUsage(),
        usageSubagents: emptyUsage(),
      };
    }
    const sum = this.summarize(s);
    const { tree } = this.buildTree(s);
    const usageByModel: Record<string, Usage> = {};
    const usageSubagents = emptyUsage();
    const tracks = [s.main, ...s.agents.values()];
    for (const t of tracks) {
      for (const [m, u] of t.byModel) {
        const b = (usageByModel[m] ??= emptyUsage());
        addUsage(b, u);
      }
      if (t !== s.main) addUsage(usageSubagents, t.usage);
    }
    const costByModel: Record<string, number | null> = {};
    for (const [m, u] of Object.entries(usageByModel)) costByModel[m] = claudeCostUsd(m, u) ?? null;
    return { ...sum, tree, usageByModel, costByModel, usageMain: { ...s.main.usage }, usageSubagents };
  }

  private summarizeRegistryOnly(r: RegistryEntry & { alive: boolean }): SessionSummary {
    const sum: SessionSummary = {
      id: r.sessionId,
      provider: PROVIDER_ID,
      projectDir: encodeCwd(r.cwd),
      cwd: r.cwd,
      live: r.alive,
      pid: r.pid,
      name: r.name ?? r.sessionId.slice(0, 8),
      lastActivityAt: r.updatedAt ?? r.startedAt ?? 0,
      hasTranscript: false,
      agentCount: 0,
      runningAgents: 0,
      usage: emptyUsage(),
      totalTokens: 0,
      costUsd: 0,
      activity: activityBuckets(new Map(), this.now()),
    };
    if (r.status) sum.status = r.status;
    if (r.statusUpdatedAt !== undefined) sum.statusUpdatedAt = r.statusUpdatedAt;
    if (r.entrypoint) sum.entrypoint = r.entrypoint;
    if (r.version) sum.version = r.version;
    if (r.kind) sum.kind = r.kind;
    if (r.startedAt !== undefined) sum.startedAt = r.startedAt;
    return sum;
  }

  private summarize(s: SessionTrack): SessionSummary {
    const reg = this.registry.get(s.id);
    const live = reg?.alive === true;
    const usage = emptyUsage();
    addUsage(usage, s.main.usage);
    let running = 0;
    const mainCost = claudeCostOfModels(s.main.byModel);
    let cost = mainCost.cost;
    let partial = mainCost.partial;
    let firstTs = s.main.firstTs;
    let lastAct = Math.max(s.main.lastTs ?? 0, s.main.mtimeMs);
    for (const a of s.agents.values()) {
      addUsage(usage, a.usage);
      const ac = claudeCostOfModels(a.byModel);
      cost += ac.cost;
      if (ac.partial) partial = true;
      if (this.agentState(s, a) === "running") running++;
      if (a.firstTs !== undefined && (firstTs === undefined || a.firstTs < firstTs)) firstTs = a.firstTs;
      lastAct = Math.max(lastAct, a.lastTs ?? 0, a.mtimeMs);
    }
    const name = reg?.name ?? s.customTitle ?? s.titleFileTitle ?? s.agentName ?? s.slug ?? s.id.slice(0, 8);
    const sum: SessionSummary = {
      id: s.id,
      provider: PROVIDER_ID,
      projectDir: s.projectDir,
      cwd: maskSecrets(live && reg?.cwd ? reg.cwd : (s.cwd ?? reg?.cwd ?? decodeProjectDir(s.projectDir))),
      live,
      name: maskSecrets(name),
      lastActivityAt: lastAct,
      hasTranscript: true,
      agentCount: s.agents.size,
      runningAgents: running,
      usage,
      totalTokens: totalTokens(usage),
      costUsd: cost,
      activity: activityBuckets(s.minutes, this.now()),
    };
    if (live && reg) {
      sum.pid = reg.pid;
      if (reg.status) sum.status = reg.status;
      if (reg.statusUpdatedAt !== undefined) sum.statusUpdatedAt = reg.statusUpdatedAt;
      if (reg.startedAt !== undefined) sum.startedAt = reg.startedAt;
      if (reg.kind) sum.kind = reg.kind;
    }
    if (partial) sum.costPartial = true;
    const entrypoint = reg?.entrypoint ?? s.entrypoint;
    if (entrypoint) sum.entrypoint = entrypoint;
    const version = reg?.version ?? s.version;
    if (version) sum.version = version;
    if (firstTs !== undefined) sum.firstActivityAt = firstTs;
    if (s.gitBranch) sum.gitBranch = s.gitBranch;
    if (s.main.model) sum.model = s.main.model;
    if (s.lastPrompt) sum.lastPrompt = s.lastPrompt;
    return sum;
  }

  /** Infer an agent's state from its last transcript entry and recency. */
  private agentState(s: SessionTrack, a: AgentTrack): AgentState {
    const now = this.now();
    const lastAct = Math.max(a.lastTs ?? 0, a.mtimeMs);
    const idleFor = now - lastAct;
    if (a.key === "main") {
      const reg = this.registry.get(s.id);
      if (reg?.alive) return reg.status === "busy" ? "running" : "idle";
      return "done";
    }
    // A task-notification with no agent activity after it is authoritative (covers killed/stopped
    // agents). Activity after it means the agent was resumed, so it can never pin a running agent.
    const n = this.finalNotification(s, a);
    if (n) {
      const outcome = notificationOutcome(n.status);
      if (outcome) return outcome;
    }
    const finished = a.lastRole === "assistant" && a.lastStop !== null && a.lastStop !== undefined && a.lastStop !== "tool_use";
    if (finished) return "done";
    // Not finished: either mid-turn or waiting on a tool. Recent activity means running.
    return idleFor < this.stallMs ? "running" : "stalled";
  }

  /** The task-notification that ended this agent, if nothing happened in the agent after it. */
  private finalNotification(s: SessionTrack, a: AgentTrack): { status: string; ts: number; summary?: string } | undefined {
    const n = a.agentId ? s.notifs.get(a.agentId) : undefined;
    return n && (a.lastTs ?? 0) <= n.ts + NOTIFY_SLACK_MS ? n : undefined;
  }

  private resolveParent(s: SessionTrack, a: AgentTrack): string {
    const toolUseId = a.meta?.toolUseId ?? (a.agentId ? s.agentToToolUse.get(a.agentId) : undefined);
    if (toolUseId) {
      const sp = s.spawns.get(toolUseId);
      if (sp && sp.ownerKey !== a.key && (sp.ownerKey === "main" || s.agents.has(sp.ownerKey))) return sp.ownerKey;
    }
    return "main";
  }

  private buildTree(s: SessionTrack): { tree: AgentNode } {
    const now = this.now();
    const nodes = new Map<string, AgentNode>();

    const mk = (a: AgentTrack): AgentNode => {
      const isMain = a.key === "main";
      const toolUseId = a.meta?.toolUseId ?? (a.agentId ? s.agentToToolUse.get(a.agentId) : undefined);
      const sp = toolUseId ? s.spawns.get(toolUseId)?.info : undefined;
      const state = this.agentState(s, a);
      const startedAt = a.firstTs;
      const lastActivityAt = a.lastTs ?? (a.mtimeMs || undefined);
      const end = state === "running" ? now : (lastActivityAt ?? now);
      const bg = a.meta?.requestShape ? a.meta.requestShape === "background" : sp?.background;
      const nodeCost = claudeCostOfModels(a.byModel);
      const node: AgentNode = {
        key: a.key,
        provider: PROVIDER_ID,
        label: isMain ? (this.summarize(s).name || "main agent") : (a.meta?.description ?? sp?.description ?? `agent ${a.key.slice(0, 8)}`),
        agentType: isMain ? "main" : (a.meta?.agentType ?? sp?.subagentType ?? "unknown"),
        mode: isMain ? "main" : bg === undefined ? "unknown" : bg ? "background" : "foreground",
        state,
        durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
        usage: { ...a.usage },
        totalTokens: totalTokens(a.usage),
        messages: a.messages,
        toolCalls: a.toolCalls,
        ticks: tickOffsets(a.ticks, startedAt),
        costUsd: nodeCost.cost,
        parentKey: isMain ? null : this.resolveParent(s, a),
        children: [],
      };
      if (nodeCost.partial) node.costPartial = true;
      if (toolUseId) node.toolUseId = toolUseId;
      if (state !== "running" && lastActivityAt !== undefined) node.endedAt = lastActivityAt;
      if (a.lastAction && state === "running") node.lastAction = a.lastAction;
      if (state === "failed" || state === "stopped") {
        const reason = this.finalNotification(s, a)?.summary;
        if (reason) node.endReason = reason;
      }
      const model = a.model ?? a.meta?.model ?? sp?.model;
      if (model) node.model = model;
      if (startedAt !== undefined) node.startedAt = startedAt;
      if (lastActivityAt !== undefined) node.lastActivityAt = lastActivityAt;
      if (a.lastTool && state === "running") node.lastTool = a.lastTool;
      if (a.meta?.spawnDepth !== undefined) node.spawnDepth = a.meta.spawnDepth;
      if (a.workflow) node.workflow = a.workflow;
      if (a.meta?.worktreeBranch) node.worktreeBranch = a.meta.worktreeBranch;
      return node;
    };

    const root = mk(s.main);
    nodes.set("main", root);
    for (const a of s.agents.values()) nodes.set(a.key, mk(a));

    // Break accidental cycles by re-parenting to main.
    for (const n of nodes.values()) {
      let cur: AgentNode | undefined = n;
      const seen = new Set<string>();
      while (cur?.parentKey) {
        if (seen.has(cur.key)) {
          n.parentKey = "main";
          break;
        }
        seen.add(cur.key);
        cur = nodes.get(cur.parentKey);
      }
    }
    for (const n of nodes.values()) {
      if (n.parentKey === null) continue;
      (nodes.get(n.parentKey) ?? root).children.push(n);
    }
    const sortRec = (n: AgentNode): void => {
      n.children.sort((x, y) => (x.startedAt ?? Infinity) - (y.startedAt ?? Infinity));
      n.children.forEach(sortRec);
    };
    sortRec(root);
    return { tree: root };
  }

  // ---- events (stateless, straight from disk by byte cursor) ----------------

  private fileFor(sessionId: string, agentKey: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    if (agentKey === "main") return s.mainFile;
    return s.agents.get(agentKey)?.file;
  }

  async readEvents(sessionId: string, agentKey: string, opts: EventQuery): Promise<EventsResult | undefined> {
    const file = this.fileFor(sessionId, agentKey);
    if (!file) return undefined;

    if (opts.after === undefined) {
      // Tail mode (newest `want` events), optionally ending at `before` to page backwards.
      const want = Math.max(1, Math.min(opts.tail ?? 150, 1000));
      let window = 512 * 1024;
      for (;;) {
        const t = await readTailLines(file, window, opts.before);
        const parsed = linesToEventsWithOffsets(t.lines, t.start);
        if (parsed.length >= want || t.complete || window >= 32 * 1024 * 1024) {
          // Cut on a line boundary so paging never splits one line's events across pages.
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
    let events = linesToEvents(r.lines);
    let truncated = false;
    if (events.length > 500) {
      events = events.slice(-500);
      truncated = true;
    }
    return { events, cursor: r.offset, start: opts.after, truncated: truncated || r.more, reset: r.reset };
  }
}

/** Like linesToEvents but remembers each event's line start byte offset (lines are "\n"-joined from `base`). */
function linesToEventsWithOffsets(lines: string[], base: number): Array<{ ev: StreamEvent; lineStart: number }> {
  const out: Array<{ ev: StreamEvent; lineStart: number }> = [];
  let off = base;
  for (const line of lines) {
    const lineStart = off;
    off += Buffer.byteLength(line, "utf8") + 1;
    const e = parseLine(line);
    if (!e) continue;
    for (const ev of toEvents(e)) out.push({ ev, lineStart });
  }
  return out;
}

function linesToEvents(lines: string[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (!e) continue;
    for (const ev of toEvents(e)) out.push(ev);
  }
  return out;
}

function emptyRoot(label: string): AgentNode {
  return {
    key: "main",
    provider: PROVIDER_ID,
    label,
    agentType: "main",
    mode: "main",
    state: "idle",
    durationMs: 0,
    usage: emptyUsage(),
    totalTokens: 0,
    messages: 0,
    toolCalls: 0,
    ticks: [],
    costUsd: 0,
    parentKey: null,
    children: [],
  };
}

/** Lossy reverse of encodeCwd (dashes are ambiguous); only used when no real cwd is known. */
export function decodeProjectDir(dir: string): string {
  return dir.replace(/^-/, "/").replace(/-/g, "/");
}
