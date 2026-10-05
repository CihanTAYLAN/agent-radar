/**
 * gemini-cli/provider.ts -- Google Gemini CLI chat recordings under ~/.gemini/tmp. Strictly read-only.
 *
 * FORMAT DERIVED FROM SOURCE (v0.20.0), NOT VERIFIED ON REAL DATA -- see format.ts.
 *
 * Discovery: `<home>/tmp/<64 hex>/chats/session-*.json` only (regular files, no symlinks). Every read goes
 * through safeToRead() with the single root `<home>/tmp`, so the rest of ~/.gemini (Antigravity data,
 * oauth_creds.json, google_accounts.json, settings.json, .env ...) is unreachable by construction.
 *
 * Each session file is one JSON document that the CLI rewrites whole, so a changed mtime/size means
 * "re-read and re-parse everything" (files above MAX_BYTES are skipped and counted in the status notes).
 *
 * Mapping: one file = one session with a single (main) agent; the schema has no subagents.
 *
 * Live heuristic (no processes are inspected):
 *   running -- file changed within liveMs (2 min) AND the last message is from the user or a tool call
 *              is still pending (validating / scheduled / awaiting_approval / executing);
 *   idle    -- otherwise, the file changed within idleMs (10 min);
 *   done    -- otherwise.
 * A session is live when running or idle.
 *
 * Event cursors are indexes into the flattened event list (not byte offsets): the file is not append-only.
 */
import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { maskSecrets } from "../../mask.js";
import {
  ACTIVITY_KEEP_MIN,
  activityBuckets,
  addUsage,
  clipLine,
  displayHome,
  emptyUsage,
  localDay,
  sessionKey,
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
import { argPaths, contentText, describeCall, isPendingStatus, parseConversation, resolveProjectRoot, toEvents, toUsage, type GConversation } from "./format.js";

export const PROVIDER_ID = "gemini-cli";
export const PROVIDER_LABEL = "Gemini CLI";

/** Session files larger than this are not read (they are rewritten whole on every message). */
export const MAX_BYTES = 50 * 1024 * 1024;
const FULL_SCAN_MS = 30_000;
const HASH_DIR = /^[0-9a-f]{64}$/;
const SESSION_FILE = /^session-[\w.-]+\.json$/;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export interface GeminiOptions {
  /** The `.gemini` directory (default `~/.gemini`). */
  geminiHome: string;
  /** Session files updated within this window are listed. Default 24h. */
  recentMs?: number;
  liveMs?: number;
  idleMs?: number;
  pollMs?: number;
  watch?: boolean;
  now?: () => number;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Candidate `gemini` binary paths (default: common install dirs + $PATH). Checked with stat only. */
  binPaths?: string[];
}

interface Track {
  file: string;
  hash: string;
  size: number;
  mtimeMs: number;
  parsed: boolean;
  id: string;
  name: string;
  lastPrompt?: string;
  cwd?: string;
  firstTs?: number;
  lastTs?: number;
  model?: string;
  usage: Usage;
  byModel: Map<string, Usage>;
  /** local day -> output tokens */
  dayOutput: Map<string, number>;
  messages: number;
  toolCalls: number;
  stamps: number[];
  toolStamps: number[];
  lastIsUser: boolean;
  pending: boolean;
  lastAction?: ToolAction;
  lastTool?: string;
  lastError?: string;
}

function bucket(m: Map<string, Usage>, k: string): Usage {
  let b = m.get(k);
  if (!b) {
    b = emptyUsage();
    m.set(k, b);
  }
  return b;
}

function newTrack(file: string, hash: string): Track {
  return {
    file,
    hash,
    size: -1,
    mtimeMs: 0,
    parsed: false,
    id: "",
    name: "",
    usage: emptyUsage(),
    byModel: new Map(),
    dayOutput: new Map(),
    messages: 0,
    toolCalls: 0,
    stamps: [],
    toolStamps: [],
    lastIsUser: false,
    pending: false,
  };
}

function nameFromPrompt(p: string): string {
  return clipLine(p, 80);
}

export class GeminiCliProvider extends EventEmitter implements Provider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;
  loading = true;

  private readonly home: string;
  private readonly recentMs: number;
  private readonly liveMs: number;
  private readonly idleMs: number;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private readonly now: () => number;
  private readonly userHome: string;
  private readonly binPaths: string[];

  /** by file path */
  private tracks = new Map<string, Track>();
  /** session id -> newest track with that id */
  private byId = new Map<string, Track>();
  private lastFull = 0;
  private needFull = false;
  private scanning = false;
  private rescan = false;
  private timer: NodeJS.Timeout | undefined;
  private kickTimer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private lastSignature = "";
  private skipped = 0;
  private filesSeen = 0;
  private eventCache = new Map<string, { mtimeMs: number; size: number; events: StreamEvent[] }>();

  constructor(opts: GeminiOptions) {
    super();
    this.home = opts.geminiHome;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.liveMs = opts.liveMs ?? 2 * 60 * 1000;
    this.idleMs = opts.idleMs ?? 10 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 2000;
    this.useWatch = opts.watch ?? true;
    this.now = opts.now ?? Date.now;
    this.userHome = opts.userHome ?? homedir();
    const env = opts.env ?? process.env;
    this.binPaths =
      opts.binPaths ??
      [
        "/opt/homebrew/bin/gemini",
        "/usr/local/bin/gemini",
        join(this.userHome, ".npm-global", "bin", "gemini"),
        join(this.userHome, ".local", "bin", "gemini"),
        ...(env["PATH"] ?? "")
          .split(delimiter)
          .filter((d) => d.length > 0)
          .map((d) => join(d, "gemini")),
      ];
  }

  private get tmpDir(): string {
    return join(this.home, "tmp");
  }
  /** Only files inside this tree are ever opened. */
  private get roots(): string[] {
    return [this.tmpDir];
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
        const w = watch(this.tmpDir, { recursive: true, persistent: false }, (_ev, name) => {
          if (!name || !String(name).endsWith(".json")) return;
          this.kick();
        });
        w.on("error", () => undefined);
        this.watchers.push(w);
      } catch {
        // Watching is an optimisation (and ~/.gemini/tmp may not exist yet); polling still works.
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
      if (full || this.needFull || now - this.lastFull > FULL_SCAN_MS) {
        this.needFull = false;
        await this.discover(now);
        this.lastFull = now;
      }
      for (const t of [...this.tracks.values()]) {
        if (await this.advance(t)) changed.add(t.id);
      }
      this.organize();
    } finally {
      this.scanning = false;
      this.loading = false;
    }
    const sig = this.signature();
    if (changed.size > 0 || sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.emit("change", [...changed].filter((x) => x).map((x) => sessionKey(PROVIDER_ID, x)));
    }
    if (this.rescan) {
      this.rescan = false;
      void this.scan(false);
    }
  }

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.totalTokens}|${s.lastActivityAt}`)
      .join("\n");
  }

  private async discover(now: number): Promise<void> {
    const seen = new Set<string>();
    let files = 0;
    let dirs: string[] = [];
    try {
      dirs = (await readdir(this.tmpDir, { withFileTypes: true })).filter((d) => d.isDirectory() && HASH_DIR.test(d.name)).map((d) => d.name);
    } catch {
      dirs = [];
    }
    for (const hash of dirs) {
      const chats = join(this.tmpDir, hash, "chats");
      let names: string[] = [];
      try {
        names = (await readdir(chats)).filter((n) => SESSION_FILE.test(n));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = join(chats, n);
        if (!safeToRead(file, this.roots)) continue;
        let st;
        try {
          st = await lstat(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        files++;
        if (now - st.mtimeMs > this.recentMs && !this.tracks.has(file)) continue;
        seen.add(file);
        if (!this.tracks.has(file)) this.tracks.set(file, newTrack(file, hash));
      }
    }
    this.filesSeen = files;
    for (const f of [...this.tracks.keys()]) {
      if (!seen.has(f)) {
        this.tracks.delete(f);
        this.eventCache.delete(f);
      }
    }
  }

  /** Re-read the file when its mtime/size changed. True when the parsed content changed. */
  private async advance(t: Track): Promise<boolean> {
    let st;
    try {
      st = await lstat(t.file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    if (t.parsed && st.size === t.size && st.mtimeMs === t.mtimeMs) return false;
    if (st.size > MAX_BYTES) {
      if (t.size !== st.size) this.skipped++;
      t.size = st.size;
      t.mtimeMs = st.mtimeMs;
      t.parsed = false;
      t.id = "";
      return false;
    }
    if (!safeToRead(t.file, this.roots)) return false;
    let text: string;
    try {
      text = await readFile(t.file, "utf8");
    } catch {
      return false;
    }
    const conv = parseConversation(text);
    // A torn read of a file being rewritten: keep what we had and retry next pass.
    if (!conv) return false;
    t.size = st.size;
    t.mtimeMs = st.mtimeMs;
    this.ingest(t, conv);
    this.eventCache.delete(t.file);
    return true;
  }

  private ingest(t: Track, conv: GConversation): void {
    const stem = (t.file.split("/").pop() ?? "").replace(/\.json$/, "");
    const id = conv.sessionId && ID_RE.test(conv.sessionId) ? conv.sessionId : ID_RE.test(stem) ? stem : "";
    t.id = id;
    t.usage = emptyUsage();
    t.byModel = new Map();
    t.dayOutput = new Map();
    t.stamps = [];
    t.toolStamps = [];
    t.messages = 0;
    t.toolCalls = 0;
    t.model = undefined;
    t.lastPrompt = undefined;
    t.name = "";
    t.lastAction = undefined;
    t.lastTool = undefined;
    t.lastError = undefined;
    t.pending = false;
    t.lastIsUser = false;
    let first: number | undefined = conv.startTime;
    let last = conv.lastUpdated ?? 0;
    const paths: string[] = [];
    let pendingCall: { name: string; args: Record<string, unknown> } | undefined;
    for (const m of conv.messages) {
      t.messages++;
      const ts = m.ts;
      if (ts !== undefined) {
        t.stamps.push(ts);
        if (first === undefined || ts < first) first = ts;
        if (ts > last) last = ts;
      }
      t.lastIsUser = m.type === "user";
      if (m.type === "user") {
        const p = contentText(m.content);
        if (p.trim()) {
          t.lastPrompt = nameFromPrompt(p);
          if (!t.name) t.name = t.lastPrompt;
        }
      } else if (m.type === "error") {
        t.lastError = clipLine(contentText(m.content), 200);
      }
      if (m.type === "gemini") {
        if (m.model) t.model = m.model;
        if (m.tokens) {
          const u = toUsage(m.tokens);
          addUsage(t.usage, u);
          addUsage(bucket(t.byModel, m.model ?? t.model ?? "unknown"), u);
          const day = localDay(ts ?? last ?? 0);
          t.dayOutput.set(day, (t.dayOutput.get(day) ?? 0) + u.output);
        }
        pendingCall = undefined;
        for (const c of m.toolCalls) {
          t.toolCalls++;
          const cts = c.ts ?? ts;
          if (cts !== undefined) {
            t.toolStamps.push(cts);
            t.stamps.push(cts);
            if (cts > last) last = cts;
          }
          for (const p of argPaths(c.args)) paths.push(p);
          if (isPendingStatus(c.status)) pendingCall = { name: c.name, args: c.args };
        }
      }
    }
    // Only the last gemini message can still be running tools; an older pending status is stale.
    const lastMsg = conv.messages[conv.messages.length - 1];
    t.pending = pendingCall !== undefined && lastMsg?.type === "gemini";
    if (t.pending && pendingCall) {
      t.lastAction = describeCall(pendingCall.name, pendingCall.args).action;
      t.lastTool = pendingCall.name;
    }
    t.firstTs = first;
    t.lastTs = last > 0 ? last : undefined;
    t.cwd = conv.projectHash ? resolveProjectRoot(conv.projectHash, paths) : undefined;
    t.parsed = t.id !== "";
  }

  /** Pick the newest file per session id (a resumed session keeps its id in one file). */
  private organize(): void {
    this.byId.clear();
    for (const t of this.tracks.values()) {
      if (!t.parsed || !t.id) continue;
      const cur = this.byId.get(t.id);
      if (!cur || t.mtimeMs > cur.mtimeMs) this.byId.set(t.id, t);
    }
  }

  // ---- state -------------------------------------------------------------------------------

  private state(t: Track): AgentState {
    const age = this.now() - t.mtimeMs;
    if (age <= this.liveMs && (t.lastIsUser || t.pending)) return "running";
    if (age <= this.idleMs) return "idle";
    return "done";
  }

  private lastActivity(t: Track): number {
    return Math.max(t.mtimeMs, t.lastTs ?? 0);
  }

  // ---- queries -----------------------------------------------------------------------------

  isSessionId(id: string): boolean {
    return ID_RE.test(id);
  }

  listSessions(): SessionSummary[] {
    return [...this.byId.values()].map((t) => this.summarize(t));
  }

  private cwdOf(t: Track): string {
    return t.cwd ? maskSecrets(t.cwd) : `proje#${t.hash.slice(0, 8)}`;
  }

  private summarize(t: Track): SessionSummary {
    const now = this.now();
    const state = this.state(t);
    const live = state === "running" || state === "idle";
    const minutes = new Map<number, number>();
    const floor = Math.floor(now / 60000) - ACTIVITY_KEEP_MIN;
    for (const ts of t.stamps) {
      const m = Math.floor(ts / 60000);
      if (m >= floor) minutes.set(m, (minutes.get(m) ?? 0) + 1);
    }
    const cwd = this.cwdOf(t);
    const sum: SessionSummary = {
      id: sessionKey(PROVIDER_ID, t.id),
      provider: PROVIDER_ID,
      projectDir: cwd,
      cwd,
      live,
      name: maskSecrets(t.name || `Gemini ${t.id.slice(0, 8)}`),
      lastActivityAt: this.lastActivity(t),
      hasTranscript: true,
      agentCount: 0,
      runningAgents: 0,
      usage: { ...t.usage },
      totalTokens: totalTokens(t.usage),
      costUsd: 0,
      activity: activityBuckets(minutes, now),
      kind: "cli",
      entrypoint: "Gemini CLI",
    };
    if (live) {
      sum.status = state === "running" ? "busy" : "idle";
      if (t.firstTs !== undefined) sum.startedAt = t.firstTs;
    }
    if (t.firstTs !== undefined) sum.firstActivityAt = t.firstTs;
    if (t.model) sum.model = t.model;
    if (t.lastPrompt) sum.lastPrompt = t.lastPrompt;
    if (state === "running") sum.runningAgents = 0;
    return sum;
  }

  getSession(nativeId: string): SessionDetail | undefined {
    const t = this.byId.get(nativeId);
    if (!t) return undefined;
    const sum = this.summarize(t);
    const state = this.state(t);
    const startedAt = t.firstTs;
    const lastActivityAt = this.lastActivity(t) || undefined;
    const end = state === "running" || state === "idle" ? this.now() : (lastActivityAt ?? this.now());
    const tree: AgentNode = {
      key: "main",
      provider: PROVIDER_ID,
      label: sum.name,
      agentType: "main",
      mode: "main",
      state,
      durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
      usage: { ...t.usage },
      totalTokens: totalTokens(t.usage),
      messages: t.messages,
      toolCalls: t.toolCalls,
      ticks: tickOffsets(t.toolStamps, startedAt),
      costUsd: 0,
      parentKey: null,
      children: [],
    };
    if (t.model) tree.model = t.model;
    if (startedAt !== undefined) tree.startedAt = startedAt;
    if (lastActivityAt !== undefined) tree.lastActivityAt = lastActivityAt;
    if (state !== "running" && state !== "idle" && lastActivityAt !== undefined) tree.endedAt = lastActivityAt;
    if (state === "running" && t.lastAction) {
      tree.lastAction = t.lastAction;
      if (t.lastTool) tree.lastTool = maskSecrets(t.lastTool);
    }
    const usageByModel: Record<string, Usage> = {};
    const costByModel: Record<string, number | null> = {};
    for (const [m, u] of t.byModel) {
      usageByModel[m] = { ...u };
      costByModel[m] = null;
    }
    return { ...sum, tree, usageByModel, costByModel, usageMain: { ...t.usage }, usageSubagents: emptyUsage() };
  }

  machine(): MachineSummary {
    const today = localDay(this.now());
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: 0, costToday: 0 };
    for (const t of this.byId.values()) {
      const st = this.state(t);
      if (st === "running" || st === "idle") out.liveSessions++;
      if (st === "running") out.runningAgents++;
      out.outputToday += t.dayOutput.get(today) ?? 0;
    }
    return out;
  }

  private binaryFound(): boolean {
    return this.binPaths.some((p) => existsSync(p));
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    let last = 0;
    for (const t of this.byId.values()) last = Math.max(last, this.lastActivity(t));
    const dataFound = this.filesSeen > 0;
    const notes = [
      "format kaynak koddan türetildi; bu makinede gerçek veriyle doğrulanmadı",
      "Canlılık tahmini: dosya değişimi (≤2 dk) + son mesaj kullanıcıdan ya da bekleyen araç çağrısı; ≤10 dk boşta",
      "Maliyet: Gemini fiyat tablosu yok (—)",
      "Proje dizini hash'ten geri çözülemezse `proje#<hash>` gösterilir",
    ];
    if (!dataFound) notes.unshift("`gemini` bir kez çalıştırılınca oturumlar görünür");
    if (this.skipped > 0) notes.push(`${this.skipped} oturum dosyası ${MAX_BYTES / 1024 / 1024} MB üstü olduğu için atlandı`);
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: "GE",
      installed: this.binaryFound(),
      dataFound,
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: true, tokens: true, tools: true, subagents: false, cost: false },
      notes,
      home: displayHome(this.home, this.userHome),
    };
    if (last > 0) st.lastActivityAt = last;
    return st;
  }

  // ---- events ------------------------------------------------------------------------------

  private async eventsFor(t: Track): Promise<StreamEvent[] | undefined> {
    const hit = this.eventCache.get(t.file);
    if (hit && hit.mtimeMs === t.mtimeMs && hit.size === t.size) return hit.events;
    if (!safeToRead(t.file, this.roots) || t.size > MAX_BYTES) return undefined;
    let text: string;
    try {
      text = await readFile(t.file, "utf8");
    } catch {
      return undefined;
    }
    const conv = parseConversation(text);
    if (!conv) return hit?.events;
    const events = toEvents(conv);
    if (this.eventCache.size >= 6) {
      const oldest = this.eventCache.keys().next().value;
      if (oldest !== undefined) this.eventCache.delete(oldest);
    }
    this.eventCache.set(t.file, { mtimeMs: t.mtimeMs, size: t.size, events });
    return events;
  }

  async readEvents(nativeId: string, agentKey: string, opts: EventQuery): Promise<EventsResult | undefined> {
    const t = this.byId.get(nativeId);
    if (!t || agentKey !== "main") return undefined;
    const all = await this.eventsFor(t);
    if (!all) return undefined;
    const total = all.length;
    if (opts.after === undefined) {
      const want = Math.max(1, Math.min(opts.tail ?? 150, 1000));
      const end = opts.before !== undefined ? Math.max(0, Math.min(opts.before, total)) : total;
      const from = Math.max(0, end - want);
      return { events: all.slice(from, end), cursor: total, start: from, truncated: from > 0, reset: false };
    }
    const reset = opts.after > total;
    const from = reset ? 0 : Math.max(0, opts.after);
    let events = all.slice(from);
    let truncated = false;
    if (events.length > 500) {
      events = events.slice(-500);
      truncated = true;
    }
    return { events, cursor: total, start: from, truncated, reset };
  }
}
