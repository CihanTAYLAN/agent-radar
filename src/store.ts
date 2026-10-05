/**
 * store.ts -- the provider-neutral aggregate the server talks to. It owns a list of providers
 * (Claude Code, Codex, ...), routes session ids to them and merges their lists and counters.
 * Strictly read-only; all tool-specific knowledge lives in src/providers/<id>/.
 */
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { ClaudeCodeProvider, type ClaudeCodeOptions } from "./providers/claude-code/provider.js";
import { localDay, parseSessionKey } from "./providers/common.js";
import { ActionMemory, buildTopics, sortTopics, type Topic, type TopicAgentInput } from "./topics.js";
import type { TopicSummarizer } from "./summarizer/index.js";
import type { AgentNode, EventQuery, EventsResult, MachineSummary, Provider, ProviderStatus, SessionDetail, SessionSummary, ToolAction } from "./providers/types.js";

export type {
  ActivityBuckets,
  AgentNode,
  AgentState,
  EventsResult,
  MachineSummary,
  Provider,
  ProviderStatus,
  SessionDetail,
  SessionSummary,
} from "./providers/types.js";
export { ACTIVITY_BUCKETS, activityBuckets, localDay, tickOffsets } from "./providers/common.js";
export { defaultPidAlive } from "./providers/claude-code/provider.js";
export { decodeProjectDir } from "./providers/claude-code/provider.js";

export interface RadarOptions extends Partial<ClaudeCodeOptions> {
  /** Explicit provider list (the entry point passes the registry's). */
  providers?: Provider[];
  /** Optional model-written topic summaries (off unless configured; see src/summarizer). */
  summarizer?: TopicSummarizer;
  userHome?: string;
}

export interface TopicsSnapshot {
  windowMs: number;
  generatedAt: number;
  topics: Topic[];
}

/** One agent in the cross-session "Şu an" list (a projection of AgentNode; nothing new is collected). */
export interface NowAgent {
  key: string;
  label: string;
  agentType: string;
  state: AgentNode["state"];
  startedAt?: number;
  lastActivityAt?: number;
  lastAction?: ToolAction;
}

export interface NowGroup {
  sessionId: string;
  sessionName: string;
  cwd: string;
  provider: string;
  agents: NowAgent[];
}

export interface FinishedToday {
  sessionId: string;
  sessionName: string;
  key: string;
  label: string;
  state: AgentNode["state"];
  endedAt: number;
  endReason?: string;
}

/** Home screen payload: what runs right now across every session, and what finished today. */
export interface NowSnapshot {
  running: NowGroup[];
  today: { done: number; failed: number; items: FinishedToday[] };
  /** Newest activity over all listed sessions (for the empty state). */
  lastActivityAt: number;
}

const TODAY_ITEMS = 200;

export class Radar extends EventEmitter {
  readonly providers: Provider[];
  private readonly byId = new Map<string, Provider>();
  private readonly clock: () => number;
  readonly summarizer: TopicSummarizer | undefined;
  private readonly userHome: string;
  private readonly actions = new ActionMemory();
  private readonly sampledAt = new Map<string, number>();
  private topicsMemo: { key: string; at: number; value: TopicsSnapshot } | undefined;

  /**
   * `new Radar({ providers })` aggregates the given providers. The legacy form
   * `new Radar({ claudeHome, ... })` builds just the Claude Code provider (used by the tests).
   */
  constructor(opts: RadarOptions) {
    super();
    this.clock = opts.now ?? Date.now;
    this.summarizer = opts.summarizer;
    this.userHome = opts.userHome ?? homedir();
    if (opts.providers) this.providers = opts.providers;
    else if (opts.claudeHome) this.providers = [new ClaudeCodeProvider(opts as ClaudeCodeOptions)];
    else throw new Error("Radar needs providers or a claudeHome");
    for (const p of this.providers) {
      this.byId.set(p.id, p);
      p.onChange((ids) => {
        this.sample(ids);
        this.emit("change", ids);
      });
    }
  }

  /** Claude Code home (kept for /api/health), or "" when that provider is not registered. */
  get home(): string {
    const p = this.byId.get("claude-code") as { home?: string } | undefined;
    return p?.home ?? "";
  }

  get loading(): boolean {
    return this.providers.some((p) => p.loading);
  }

  start(): void {
    for (const p of this.providers) p.start();
  }

  stop(): void {
    for (const p of this.providers) p.stop();
  }

  async scan(full = false): Promise<void> {
    await Promise.all(this.providers.map((p) => p.scan(full)));
  }

  private route(id: string): { p: Provider; nativeId: string } | undefined {
    const { provider, nativeId } = parseSessionKey(id);
    const p = this.byId.get(provider);
    return p && p.isSessionId(nativeId) ? { p, nativeId } : undefined;
  }

  /** True when the id names a registered provider and is well-formed for it. */
  isSessionId(id: string): boolean {
    return this.route(id) !== undefined;
  }

  listSessions(): SessionSummary[] {
    const out = this.providers.flatMap((p) => p.listSessions());
    return out.sort((a, b) => Number(b.live) - Number(a.live) || b.lastActivityAt - a.lastActivityAt);
  }

  getSession(id: string): SessionDetail | undefined {
    const r = this.route(id);
    return r ? r.p.getSession(r.nativeId) : undefined;
  }

  async readEvents(id: string, agentKey: string, q: EventQuery): Promise<EventsResult | undefined> {
    const r = this.route(id);
    return r ? r.p.readEvents(r.nativeId, agentKey, q) : undefined;
  }

  /** Machine-wide counters summed over providers, plus the per-provider split for tooltips. */
  machine(): MachineSummary & { byProvider: Record<string, MachineSummary> } {
    const out: MachineSummary & { byProvider: Record<string, MachineSummary> } = {
      liveSessions: 0,
      runningAgents: 0,
      finishedToday: 0,
      outputToday: 0,
      costToday: 0,
      byProvider: {},
    };
    for (const p of this.providers) {
      const m = p.machine();
      out.byProvider[p.id] = m;
      out.liveSessions += m.liveSessions;
      out.runningAgents += m.runningAgents;
      out.finishedToday += m.finishedToday;
      out.outputToday += m.outputToday;
      out.costToday += m.costToday;
    }
    return out;
  }

  /**
   * Running agents grouped by session (main only while it is "running", sub-agents while running or
   * stalled), plus today's finished sub-agents. A projection of the in-memory session trees; it
   * reads nothing from disk and collects nothing new.
   */
  nowSnapshot(): NowSnapshot {
    const today = localDay(this.clock());
    const running: NowGroup[] = [];
    const items: FinishedToday[] = [];
    let done = 0;
    let failed = 0;
    let lastActivityAt = 0;
    for (const s of this.listSessions()) {
      lastActivityAt = Math.max(lastActivityAt, s.lastActivityAt);
      const touchedToday = s.lastActivityAt > 0 && localDay(s.lastActivityAt) === today;
      if (!s.live && !touchedToday) continue;
      const d = this.getSession(s.id);
      if (!d) continue;
      const agents: NowAgent[] = [];
      const walk = (n: AgentNode): void => {
        const isMain = n.key === "main";
        if (s.live && (isMain ? n.state === "running" : n.state === "running" || n.state === "stalled")) {
          agents.push({ key: n.key, label: isMain ? "Ana ajan" : n.label, agentType: n.agentType, state: n.state, startedAt: n.startedAt, lastActivityAt: n.lastActivityAt, lastAction: n.lastAction });
        } else if (!isMain && (n.state === "done" || n.state === "stopped" || n.state === "failed")) {
          const end = n.endedAt ?? n.lastActivityAt;
          if (end !== undefined && localDay(end) === today) {
            if (n.state === "failed") failed++;
            else done++;
            items.push({ sessionId: s.id, sessionName: s.name, key: n.key, label: n.label, state: n.state, endedAt: end, endReason: n.endReason });
          }
        }
        for (const c of n.children) walk(c);
      };
      walk(d.tree);
      if (agents.length) {
        agents.sort((a, b) => Number(b.key === "main") - Number(a.key === "main") || Number(a.state === "stalled") - Number(b.state === "stalled") || (a.startedAt ?? 0) - (b.startedAt ?? 0));
        running.push({ sessionId: s.id, sessionName: s.name, cwd: s.cwd, provider: s.provider, agents });
      }
    }
    items.sort((a, b) => b.endedAt - a.endedAt);
    return { running, today: { done, failed, items: items.slice(0, TODAY_ITEMS) }, lastActivityAt };
  }

  /** Remembers the pending edit/PR actions of a session's agents (in memory; throttled per session). */
  private sample(ids: string[]): void {
    const t = this.clock();
    for (const id of ids) {
      if (!this.route(id) || t - (this.sampledAt.get(id) ?? 0) < 1500) continue;
      this.sampledAt.set(id, t);
      const d = this.getSession(id);
      if (!d) continue;
      const walk = (n: AgentNode): void => {
        if (n.lastAction) this.actions.observe(id, n.key, n.lastAction, d.cwd, this.userHome);
        n.children.forEach(walk);
      };
      walk(d.tree);
    }
  }

  /**
   * Konular: what work is being done, grouped semantically (see topics.ts). A projection of the
   * in-memory session trees plus the actions sampled so far; reads nothing from disk.
   */
  topics(windowMs: number): TopicsSnapshot {
    const now = this.clock();
    if (this.topicsMemo && this.topicsMemo.key === String(windowMs) && now - this.topicsMemo.at < 1500) return this.topicsMemo.value;
    const cutoff = now - windowMs;
    const inputs: TopicAgentInput[] = [];
    for (const s of this.listSessions()) {
      if (!s.live && s.lastActivityAt < cutoff) continue;
      const d = this.getSession(s.id);
      if (!d) continue;
      const walk = (n: AgentNode): void => {
        const isMain = n.key === "main";
        const running = n.state === "running" || n.state === "stalled";
        const at = n.lastActivityAt ?? n.endedAt ?? n.startedAt ?? 0;
        if (n.lastAction) this.actions.observe(s.id, n.key, n.lastAction, d.cwd, this.userHome);
        if (running || at >= cutoff || (isMain && s.live)) {
          const activity = this.actions.get(s.id, n.key);
          inputs.push({
            sessionId: s.id,
            sessionName: s.name,
            provider: s.provider,
            cwd: s.cwd,
            isMain,
            ...(isMain && s.gitBranch ? { gitBranch: s.gitBranch } : {}),
            ...(isMain && s.lastPrompt ? { lastPrompt: s.lastPrompt } : {}),
            agentKey: n.key,
            label: n.label,
            agentType: n.agentType,
            state: n.state,
            ...(n.startedAt !== undefined ? { startedAt: n.startedAt } : {}),
            lastActivityAt: at || undefined,
            costUsd: n.costUsd,
            ...(n.costPartial ? { costPartial: true } : {}),
            ...(n.worktreeBranch ? { worktreeBranch: n.worktreeBranch } : {}),
            ...(n.lastAction ? { lastAction: n.lastAction } : {}),
            ...(activity ? { activity } : {}),
          });
        }
        n.children.forEach(walk);
      };
      walk(d.tree);
    }
    const topics = sortTopics(buildTopics(inputs, { home: this.userHome }));
    if (this.summarizer) {
      for (const t of topics.slice(0, 12)) this.summarizer.offer(t);
      for (const t of topics) {
        const g = this.summarizer.get(t.id);
        if (g) {
          t.llmSummary = g.text;
          t.llmAt = g.at;
        }
      }
    }
    const value: TopicsSnapshot = { windowMs, generatedAt: now, topics };
    this.topicsMemo = { key: String(windowMs), at: now, value };
    return value;
  }

  providerStatus(): ProviderStatus[] {
    return this.providers.map((p) => p.status());
  }
}
