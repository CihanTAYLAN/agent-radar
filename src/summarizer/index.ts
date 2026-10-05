/**
 * summarizer/index.ts -- OPTIONAL model-written topic summaries behind one pluggable interface.
 * OFF unless AGENT_RADAR_SUMMARIZER names a backend; only "codex" exists today (see codex.ts).
 * Here: prompt building (masked, <= 2000 chars), facts hash, in-memory cache, one-at-a-time queue,
 * per-topic debounce and an hourly call cap. Failures degrade silently to the Layer 1 summary.
 * This file never spawns anything and never touches the filesystem.
 */
import { createHash } from "node:crypto";
import { maskSecrets } from "../mask.js";
import type { Topic } from "../topics.js";
import { createCodexBackend, type CodexOptions } from "./codex.js";

export interface SummaryBackend {
  id: string;
  label: string;
  model: string;
  /** What leaves the machine, in Turkish (shown in the settings menu). */
  disclosure: string;
  /** Returns the summary text; throws on any failure. */
  summarize(prompt: string): Promise<string>;
}

export interface SummarizerStatus {
  enabled: boolean;
  backend?: string;
  model?: string;
  disclosure?: string;
  reason?: string;
  callsLastHour: number;
  maxPerHour: number;
  lastError?: string;
  lastOkAt?: number;
}

export const PROMPT_MAX = 2000;
const INSTRUCTION =
  "Aşağıdaki iş konusunu özetle: ne yapılıyor ve nerede kaldı; 1-2 cümle Türkçe, şimdiki zaman, betimleyici bir durum özeti. Emir kipi kullanma, araç kullanma, başlık veya madde işareti ekleme; yalnızca özet metnini yaz.\n\n";

/** Compact, masked prompt (<= PROMPT_MAX chars) from a topic's facts. */
export function buildPrompt(t: Topic): string {
  const lines: string[] = [`Konu: ${t.key ? `${t.key} ` : ""}${t.title}`, `Proje: ${t.project}`, `Ajanlar: ${t.counts.total} (çalışan ${t.counts.running}, biten ${t.counts.done}, başarısız ${t.counts.failed})`];
  const labels = t.agents.filter((a) => !a.isMain).slice(0, 12).map((a) => `- [${a.state}] ${a.label}`);
  if (labels.length) lines.push("Alt ajan görevleri:", ...labels);
  if (t.recent.length) lines.push("Son eylemler:", ...t.recent.map((r) => `- ${r}`));
  if (t.modules.length) lines.push(`Dokunulan modüller: ${t.modules.join(", ")}`);
  const facts = maskSecrets(lines.join("\n"));
  const room = PROMPT_MAX - INSTRUCTION.length;
  return INSTRUCTION + (facts.length > room ? `${facts.slice(0, room - 1)}…` : facts);
}

/** Facts hash: agent ids + states + last activity + counts. */
export function topicHash(t: Topic): string {
  const h = createHash("sha1");
  h.update(t.agents.map((a) => `${a.sessionId}|${a.key}|${a.state}`).sort().join(","));
  h.update(`|${t.lastAt}|${t.counts.running}|${t.counts.done}|${t.counts.failed}`);
  return h.digest("hex").slice(0, 16);
}

export interface SummarizerOptions {
  backend?: SummaryBackend;
  /** Why there is no backend (shown as the status reason). */
  reason?: string;
  now?: () => number;
  onUpdate?: () => void;
  maxPerHour?: number;
  /** Minimum time between two summaries of the same topic. */
  debounceMs?: number;
  /** Only topics with running agents or activity within this window are summarized. */
  activeWindowMs?: number;
}

interface Entry {
  hash: string;
  text: string;
  at: number;
}
interface Job {
  id: string;
  hash: string;
  prompt: string;
}

export class TopicSummarizer {
  private readonly backend: SummaryBackend | undefined;
  private readonly reason: string | undefined;
  private readonly now: () => number;
  private readonly onUpdate: (() => void) | undefined;
  private readonly debounceMs: number;
  private readonly activeWindowMs: number;
  readonly maxPerHour: number;

  private readonly cache = new Map<string, Entry>();
  private readonly lastTry = new Map<string, number>();
  private readonly queued = new Map<string, Job>();
  private readonly calls: number[] = [];
  private running = false;
  private lastError: string | undefined;
  private lastOkAt: number | undefined;

  constructor(opts: SummarizerOptions = {}) {
    this.backend = opts.backend;
    this.reason = opts.backend ? undefined : opts.reason ?? "kapalı";
    this.now = opts.now ?? Date.now;
    this.onUpdate = opts.onUpdate;
    this.debounceMs = opts.debounceMs ?? 10 * 60_000;
    this.activeWindowMs = opts.activeWindowMs ?? 2 * 3600_000;
    this.maxPerHour = opts.maxPerHour ?? 20;
  }

  private prune(): void {
    const cut = this.now() - 3600_000;
    while (this.calls.length && (this.calls[0] as number) <= cut) this.calls.shift();
  }

  status(): SummarizerStatus {
    this.prune();
    const s: SummarizerStatus = { enabled: Boolean(this.backend), callsLastHour: this.calls.length, maxPerHour: this.maxPerHour };
    if (this.backend) Object.assign(s, { backend: this.backend.id, model: this.backend.model, disclosure: this.backend.disclosure });
    else s.reason = this.reason;
    if (this.lastError) s.lastError = this.lastError;
    if (this.lastOkAt) s.lastOkAt = this.lastOkAt;
    return s;
  }

  get(id: string): { text: string; at: number } | undefined {
    const e = this.cache.get(id);
    return e ? { text: e.text, at: e.at } : undefined;
  }

  /** Offers a topic: no-op when off, inactive, unchanged or debounced; otherwise queues one call. */
  offer(t: Topic): void {
    if (!this.backend || t.kind === "other") return;
    if (t.counts.running === 0 && this.now() - t.lastAt > this.activeWindowMs) return;
    const hash = topicHash(t);
    if (this.cache.get(t.id)?.hash === hash) return;
    const last = this.lastTry.get(t.id);
    if (last !== undefined && this.now() - last < this.debounceMs) return;
    this.queued.set(t.id, { id: t.id, hash, prompt: buildPrompt(t) });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || !this.backend) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.queued.entries().next().value as [string, Job] | undefined;
        if (!next) return;
        this.queued.delete(next[0]);
        this.prune();
        if (this.calls.length >= this.maxPerHour) {
          this.queued.clear();
          return;
        }
        this.calls.push(this.now());
        this.lastTry.set(next[1].id, this.now());
        try {
          const raw = await this.backend.summarize(next[1].prompt);
          const text = maskSecrets(raw.replace(/\s+/g, " ").trim());
          if (!text) throw new Error("boş yanıt");
          this.cache.set(next[1].id, { hash: next[1].hash, text: text.length > 400 ? `${text.slice(0, 399)}…` : text, at: this.now() });
          this.lastError = undefined;
          this.lastOkAt = this.now();
          this.onUpdate?.();
        } catch (err) {
          this.lastError = maskSecrets(err instanceof Error ? err.message : String(err)).slice(0, 160);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Resolves when the queue is drained (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queued.size) await new Promise((r) => setTimeout(r, 0));
  }
}

export interface SummarizerEnvDeps extends Pick<CodexOptions, "run" | "exists" | "scratch"> {
  now?: () => number;
  onUpdate?: () => void;
}

/** Builds the summarizer from env: AGENT_RADAR_SUMMARIZER=codex turns it on; anything else keeps it off. */
export function createSummarizer(env: NodeJS.ProcessEnv, deps: SummarizerEnvDeps = {}): TopicSummarizer {
  const name = env["AGENT_RADAR_SUMMARIZER"]?.trim().toLowerCase();
  const n = Number(env["AGENT_RADAR_SUMMARIZER_MAX_PER_HOUR"] ?? "20");
  const base: SummarizerOptions = {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onUpdate ? { onUpdate: deps.onUpdate } : {}),
    maxPerHour: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20,
  };
  if (!name) return new TopicSummarizer({ ...base, reason: "AGENT_RADAR_SUMMARIZER=codex ile açılır" });
  if (name !== "codex") return new TopicSummarizer({ ...base, reason: `bilinmeyen özetleyici: ${name.slice(0, 20)}` });
  const { backend, reason } = createCodexBackend({
    env,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.scratch ? { scratch: deps.scratch } : {}),
  });
  return new TopicSummarizer({ ...base, ...(backend ? { backend } : { reason: reason ?? "kapalı" }) });
}
