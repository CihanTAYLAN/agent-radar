/**
 * antigravity/provider.ts -- Google Antigravity, summary/metadata only.
 *
 * Antigravity keeps its conversations as encrypted protobuf, so the single readable index is
 * `conversation_summaries.db` (one per data dir: `antigravity`, and the older `antigravity-ide`).
 * That is the ONLY file this provider opens: the guard's roots are exactly those DB files, so the
 * conversations, brain, browser profile, OAuth token and config are unreachable by construction.
 * `preview` and the opaque `raw_summary` blob are never selected.
 *
 * Every pass opens each DB read-only (never `immutable=1`: it is WAL-mode and held by the `agy` hub),
 * reads the rows and closes it again. Liveness comes from the rows' own timestamps, not the DB file mtime.
 *
 * Mapping: a row without a parent is a session, child rows are subagents (recursively). Rows sharing
 * a battle_id under the same parent are parallel attempts; the winner (winning_conversation_id) is
 * flagged "kazanan". For root-level battles the winner (else newest attempt) is the session's main
 * agent and the other attempts are listed next to it as "paralel deneme".
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecrets } from "../../mask.js";
import { ACTIVITY_KEEP_MIN, activityBuckets, clipLine, displayHome, emptyUsage, isObj, localDay, sessionKey, str } from "../common.js";
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
} from "../types.js";
import { type ConvRow, WANT_COLUMNS, isConversationId, liveness, toConvRow } from "./format.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_LABEL = "Antigravity";

export interface AntigravityOptions {
  /** `~/.gemini` (holds `antigravity/`, `antigravity-ide/` and the `bin/agy` backend). */
  geminiHome: string;
  /** Extra "is it installed" hints (app bundles); tests pass []. */
  appPaths?: string[];
  recentMs?: number;
  pollMs?: number;
  userHome?: string;
  now?: () => number;
}

const MAX_ROWS = 5000;
const MAX_DEPTH = 32;
const DATA_DIRS = ["antigravity", "antigravity-ide"];
const DEFAULT_APPS = process.platform === "darwin" ? ["/Applications/Antigravity.app", "/Applications/Antigravity IDE.app"] : [];

interface SessionModel {
  primary: string;
  members: Set<string>;
  /** Effective parent within the session (main has none). */
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  lastActivity: number;
}

function cleanTitle(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = clipLine(s, 120);
  return t || undefined;
}

export class AntigravityProvider extends EventEmitter implements Provider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;
  readonly home: string;
  private readonly recentMs: number;
  private readonly pollMs: number;
  private readonly userHome: string;
  private readonly appPaths: string[];
  private readonly now: () => number;

  private rows = new Map<string, ConvRow>();
  private sessions = new Map<string, SessionModel>();
  private totalRows = 0;
  private lastAny = 0;
  private dbsFound = 0;
  private dbsFailed = 0;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private rescan = false;
  private lastSignature = "";
  loading = true;

  constructor(opts: AntigravityOptions) {
    super();
    this.home = opts.geminiHome;
    this.recentMs = opts.recentMs ?? 24 * 3600 * 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.userHome = opts.userHome ?? homedir();
    this.appPaths = opts.appPaths ?? DEFAULT_APPS;
    this.now = opts.now ?? Date.now;
  }

  /** The only readable files: one summaries DB per data dir. */
  private get dbPaths(): string[] {
    return DATA_DIRS.map((d) => join(this.home, d, "conversation_summaries.db"));
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

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
    this.timer = undefined;
  }

  // ---- scanning ----------------------------------------------------------------------------------

  async scan(_full = false): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      await this.load();
      this.organize();
    } finally {
      this.scanning = false;
      this.loading = false;
    }
    const before = this.lastSignature;
    this.lastSignature = this.signature();
    if (this.lastSignature !== before) this.emit("change", this.listSessions().map((s) => s.id));
    if (this.rescan) {
      this.rescan = false;
      void this.scan(false);
    }
  }

  private signature(): string {
    return this.listSessions()
      .map((s) => `${s.id}|${s.live ? 1 : 0}|${s.status ?? ""}|${s.runningAgents}|${s.agentCount}|${s.lastActivityAt}`)
      .join("\n");
  }

  /** Opens every DB read-only, reads the rows, closes it. A broken DB never breaks the others. */
  private async load(): Promise<void> {
    const mod = await loadSqlite();
    const roots = this.dbPaths;
    if (!mod) {
      this.dbsFound = roots.filter((p) => existsSync(p)).length;
      this.dbsFailed = this.dbsFound;
      return;
    }
    const rows = new Map<string, ConvRow>();
    let found = 0;
    let failed = 0;
    for (const path of roots) {
      if (!existsSync(path)) continue;
      found++;
      if (!safeToRead(path, roots)) {
        failed++;
        continue;
      }
      try {
        const db = new mod.DatabaseSync(path, { readOnly: true });
        try {
          const cols = new Set(
            db
              .prepare("PRAGMA table_info(conversation_summaries)")
              .all()
              .map((c) => (isObj(c) ? str(c["name"]) : undefined))
              .filter((x): x is string => x !== undefined),
          );
          if (!cols.has("conversation_id") || !cols.has("last_modified_time")) throw new Error("unexpected schema");
          const sel = WANT_COLUMNS.filter((c) => cols.has(c))
            .map((c) => `"${c}"`)
            .join(", ");
          for (const r of db.prepare(`SELECT ${sel} FROM conversation_summaries LIMIT ${MAX_ROWS}`).all()) {
            const row = isObj(r) ? toConvRow(r) : undefined;
            if (row && !rows.has(row.id)) rows.set(row.id, row);
          }
        } finally {
          db.close();
        }
      } catch {
        failed++;
      }
    }
    this.dbsFound = found;
    this.dbsFailed = failed;
    // A pass in which every DB failed keeps the previous rows instead of blanking the UI.
    if (found > 0 && failed === found) return;
    this.rows = rows;
  }

  private last(r: ConvRow): number {
    return r.lastModified ?? r.lastUserInput ?? 0;
  }

  /** Groups rows into sessions: roots, children, battle groups; keeps sessions inside the recent window. */
  private organize(): void {
    const now = this.now();
    const since = now - this.recentMs;
    const rows = this.rows;

    // Parent links that resolve to a different, known row; cycles are cut.
    const parent = new Map<string, string>();
    for (const r of rows.values()) if (r.parent && r.parent !== r.id && rows.has(r.parent)) parent.set(r.id, r.parent);
    for (const id of [...parent.keys()]) {
      const seen = new Set<string>([id]);
      let p = parent.get(id);
      while (p !== undefined) {
        if (seen.has(p)) {
          parent.delete(id);
          break;
        }
        seen.add(p);
        p = parent.get(p);
      }
    }

    // Battle groups: same battle_id under the same parent. Root-level groups collapse into one session.
    const groups = new Map<string, ConvRow[]>();
    for (const r of rows.values()) {
      if (!r.battleId) continue;
      const k = `${parent.get(r.id) ?? ""}\u0000${r.battleId}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    const eff = new Map(parent);
    for (const [k, g] of groups) {
      if (g.length < 2 || !k.startsWith("\u0000")) continue;
      const win = g.map((m) => m.winner).find((w) => w && g.some((m) => m.id === w));
      const primary = g.find((m) => m.id === win) ?? [...g].sort((a, b) => this.last(b) - this.last(a))[0];
      if (!primary) continue;
      for (const m of g) if (m !== primary) eff.set(m.id, primary.id);
    }

    const childrenOf = new Map<string, string[]>();
    for (const [c, p] of eff) {
      const l = childrenOf.get(p);
      if (l) l.push(c);
      else childrenOf.set(p, [c]);
    }

    const sessions = new Map<string, SessionModel>();
    let lastAny = 0;
    for (const r of rows.values()) {
      lastAny = Math.max(lastAny, this.last(r));
      if (eff.has(r.id)) continue;
      const members = new Set<string>();
      const parentOf = new Map<string, string>();
      const kids = new Map<string, string[]>();
      const walk = (id: string, depth: number): void => {
        if (members.has(id) || depth > MAX_DEPTH) return;
        members.add(id);
        for (const c of childrenOf.get(id) ?? []) {
          if (members.has(c)) continue;
          parentOf.set(c, id);
          const l = kids.get(id);
          if (l) l.push(c);
          else kids.set(id, [c]);
          walk(c, depth + 1);
        }
      };
      walk(r.id, 0);
      let la = 0;
      for (const id of members) la = Math.max(la, this.last(rows.get(id) as ConvRow));
      if (la < since) continue;
      sessions.set(r.id, { primary: r.id, members, parentOf, childrenOf: kids, lastActivity: la });
    }
    this.sessions = sessions;
    this.totalRows = rows.size;
    this.lastAny = lastAny;
  }

  // ---- queries -----------------------------------------------------------------------------------

  isSessionId(id: string): boolean {
    return isConversationId(id);
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((m) => this.summarize(m)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  private row(id: string): ConvRow {
    return this.rows.get(id) as ConvRow;
  }

  private startOf(r: ConvRow): number | undefined {
    const t = [r.lastUserInput, r.lastModified].filter((x): x is number => x !== undefined);
    return t.length > 0 ? Math.min(...t) : undefined;
  }

  private display(r: ConvRow): string {
    return cleanTitle(r.title) ?? cleanTitle(r.agentName) ?? r.id.slice(0, 8);
  }

  private summarize(m: SessionModel): SessionSummary {
    const now = this.now();
    const root = this.row(m.primary);
    const rootLive = liveness(root, now);
    let running = 0;
    let first: number | undefined;
    const minutes = new Map<number, number>();
    for (const id of m.members) {
      const r = this.row(id);
      if (id !== m.primary && liveness(r, now).state === "running") running++;
      const s = this.startOf(r);
      if (s !== undefined && (first === undefined || s < first)) first = s;
      const l = this.last(r);
      if (l > 0 && now - l <= ACTIVITY_KEEP_MIN * 60000) minutes.set(Math.floor(l / 60000), (minutes.get(Math.floor(l / 60000)) ?? 0) + 1);
    }
    const live = rootLive.state === "running" || rootLive.state === "idle" || running > 0;
    const cwd = root.workspace ? displayHome(root.workspace, this.userHome) : "";
    const sum: SessionSummary = {
      id: sessionKey(PROVIDER_ID, m.primary),
      provider: PROVIDER_ID,
      projectDir: cwd,
      cwd,
      live,
      name: maskSecrets(this.display(root)),
      lastActivityAt: m.lastActivity,
      // The timeline only draws bars for sessions flagged as having a transcript; ours has
      // timestamps for its bars but no transcript, which is what capabilities.transcript=false says.
      hasTranscript: true,
      agentCount: m.members.size - 1,
      runningAgents: running,
      usage: emptyUsage(),
      totalTokens: 0,
      costUsd: 0,
      activity: activityBuckets(minutes, now),
      kind: root.agentName ? maskSecrets(root.agentName) : "antigravity",
      entrypoint: maskSecrets(["Antigravity", root.source, root.agentName].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ")),
    };
    const label = running > 0 && rootLive.state !== "running" ? "busy" : rootLive.label;
    if (label) sum.status = label;
    if (first !== undefined) {
      sum.firstActivityAt = first;
      if (live) sum.startedAt = first;
    }
    return sum;
  }

  getSession(nativeId: string): SessionDetail | undefined {
    const m = this.sessions.get(nativeId);
    if (!m) return undefined;
    const sum = this.summarize(m);
    return { ...sum, tree: this.node(m, m.primary, 0), usageByModel: {}, costByModel: {}, usageMain: emptyUsage(), usageSubagents: emptyUsage() };
  }

  /** Battle info for a row: is it part of a group, and is it the flagged winner. */
  private battleOf(id: string): { inBattle: boolean; winner: boolean } {
    const r = this.row(id);
    if (!r.battleId) return { inBattle: false, winner: false };
    let winner = false;
    let inBattle = false;
    for (const o of this.rows.values()) {
      if (o.battleId !== r.battleId) continue;
      if (o.id !== r.id) inBattle = true;
      if (o.winner === r.id) winner = true;
    }
    return { inBattle, winner };
  }

  private node(m: SessionModel, id: string, depth: number): AgentNode {
    const now = this.now();
    const r = this.row(id);
    const isMain = id === m.primary;
    const lv = liveness(r, now);
    const state: AgentState = lv.state;
    const startedAt = this.startOf(r);
    const lastActivityAt = this.last(r) || undefined;
    const end = state === "running" || state === "idle" ? now : (lastActivityAt ?? now);
    const b = this.battleOf(id);
    const flags = [
      r.agentName,
      r.stepCount > 0 ? `${r.stepCount} adım` : "",
      r.source,
      r.status.toLowerCase().replace(/^cascade_run_status_/, ""),
      b.winner ? "kazanan" : b.inBattle ? "paralel deneme" : "",
    ].filter((x, i, a) => x && a.indexOf(x) === i);
    const parentId = m.parentOf.get(id);
    const node: AgentNode = {
      key: isMain ? "main" : id,
      provider: PROVIDER_ID,
      label: maskSecrets(this.display(r)) + (b.winner && !isMain ? " · kazanan" : ""),
      agentType: maskSecrets(flags.join(" · ") || "alt ajan"),
      mode: isMain ? "main" : "unknown",
      state,
      durationMs: startedAt !== undefined ? Math.max(0, end - startedAt) : 0,
      usage: emptyUsage(),
      totalTokens: 0,
      messages: r.stepCount,
      toolCalls: 0,
      ticks: [],
      costUsd: 0,
      parentKey: isMain ? null : parentId === m.primary || parentId === undefined ? "main" : parentId,
      children: [],
    };
    const meta: Record<string, string | number> = {};
    if (r.stepCount > 0) meta["Adım sayısı"] = r.stepCount;
    if (r.agentName) meta["Agent"] = maskSecrets(r.agentName);
    if (r.source) meta["Kaynak"] = maskSecrets(r.source);
    const durum = r.status.toLowerCase().replace(/^cascade_run_status_/, "");
    if (durum) meta["Durum"] = maskSecrets(durum);
    if (b.winner) meta["Kazanan"] = "evet";
    else if (b.inBattle) meta["Kazanan"] = "hayır (paralel deneme)";
    if (Object.keys(meta).length > 0) node.meta = meta;
    if (startedAt !== undefined) node.startedAt = startedAt;
    if (lastActivityAt !== undefined) node.lastActivityAt = lastActivityAt;
    if (state !== "running" && state !== "idle" && lastActivityAt !== undefined) node.endedAt = lastActivityAt;
    if (state === "stopped") node.endReason = "Konuşma sonlandırıldı (killed)";
    if (!isMain && r.depth > 0) node.spawnDepth = r.depth;
    if (depth < MAX_DEPTH) {
      node.children = (m.childrenOf.get(id) ?? [])
        .map((c) => this.node(m, c, depth + 1))
        .sort((x, y) => (x.startedAt ?? Infinity) - (y.startedAt ?? Infinity));
    }
    return node;
  }

  /** No transcript exists in a readable form; the UI does not ask (capabilities.transcript=false), but stay safe. */
  async readEvents(nativeId: string, _agentKey: string, _q: EventQuery): Promise<EventsResult | undefined> {
    if (!this.sessions.has(nativeId)) return undefined;
    return { events: [], cursor: 0, start: 0, truncated: false, reset: false };
  }

  machine(): MachineSummary {
    const now = this.now();
    const today = localDay(now);
    const out: MachineSummary = { liveSessions: 0, runningAgents: 0, finishedToday: 0, outputToday: 0, costToday: 0 };
    for (const s of this.listSessions()) if (s.live) out.liveSessions++;
    for (const m of this.sessions.values()) {
      for (const id of m.members) {
        const r = this.row(id);
        const st = liveness(r, now).state;
        if (st === "running") out.runningAgents++;
        else if (id !== m.primary && (st === "done" || st === "stopped") && this.last(r) > 0 && localDay(this.last(r)) === today) out.finishedToday++;
      }
    }
    return out;
  }

  status(): ProviderStatus {
    const sessions = this.listSessions();
    const agy = join(this.home, "bin", "agy");
    const dataDirs = DATA_DIRS.filter((d) => existsSync(join(this.home, d)));
    const notes = [
      "yalnızca özet (konuşmalar şifreli protobuf)",
      "Kaynak: conversation_summaries.db (salt okunur, her turda açılıp kapanır); konuşma, tarayıcı profili ve OAuth dosyaları okunmaz",
      "Canlılık: durum adı + son değişiklik zamanı (boşta ≤2 dk, çalışıyor ≤10 dk); DB dosya zamanına bakılmaz",
    ];
    if (this.dbsFound === 0) notes.push("conversation_summaries.db bulunamadı");
    else if (this.dbsFailed > 0) notes.push(`${this.dbsFailed} veritabanı okunamadı`);
    const st: ProviderStatus = {
      id: this.id,
      label: this.label,
      mark: "AG",
      installed: existsSync(agy) || dataDirs.length > 0 || this.appPaths.some((p) => existsSync(p)),
      dataFound: this.totalRows > 0,
      sessions: sessions.length,
      active: sessions.filter((s) => s.live).length,
      capabilities: { transcript: false, tokens: false, tools: false, subagents: true, cost: false },
      notes,
      home: displayHome(this.home, this.userHome),
    };
    if (this.lastAny > 0) st.lastActivityAt = this.lastAny;
    return st;
  }
}
