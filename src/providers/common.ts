/**
 * common.ts -- small helpers shared by every provider (no on-disk format knowledge).
 */
import { maskSecrets } from "../mask.js";
import type { ActivityBuckets, ProviderId, Usage } from "./types.js";

// ---------------------------------------------------------------------------
// Global session ids
// ---------------------------------------------------------------------------

/** The provider that owns the bare (un-prefixed) id namespace, for backwards-compatible deep links. */
export const DEFAULT_PROVIDER: ProviderId = "claude-code";

export function sessionKey(provider: ProviderId, nativeId: string): string {
  return provider === DEFAULT_PROVIDER ? nativeId : `${provider}:${nativeId}`;
}

export function parseSessionKey(id: string): { provider: ProviderId; nativeId: string } {
  const i = id.indexOf(":");
  if (i < 0) return { provider: DEFAULT_PROVIDER, nativeId: id };
  return { provider: id.slice(0, i), nativeId: id.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Defensive value readers
// ---------------------------------------------------------------------------

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

export function addUsage(into: Usage, u: Usage, sign: 1 | -1 = 1): void {
  into.input += sign * u.input;
  into.output += sign * u.output;
  into.cacheRead += sign * u.cacheRead;
  into.cacheCreate += sign * u.cacheCreate;
  if (u.cacheCreate1h || into.cacheCreate1h !== undefined) into.cacheCreate1h = (into.cacheCreate1h ?? 0) + sign * (u.cacheCreate1h ?? 0);
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreate;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Mask, collapse to one line and cut to `max` with a plain ellipsis. Pre-cutting with slack before
 * masking is safe for the same reason as in safeText: the slack is always discarded.
 */
export function clipLine(s: string, max: number): string {
  const pre = s.length > max + 512 ? s.slice(0, max + 512) : s;
  const one = oneLine(maskSecrets(pre));
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Paths are shortened to their last 3 segments so they stay readable in a narrow panel. */
export function shortPath(p: string, keep = 3): string {
  const parts = p.split("/").filter((x) => x.length > 0);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join("/")}`;
}

const CD_PREFIX = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;

/** Splits leading `cd <dir> &&` / `cd <dir>;` prefixes off a shell command. The last dir wins. */
export function splitCdPrefix(cmd: string): { dir?: string; rest: string } {
  let rest = cmd;
  let dir: string | undefined;
  for (let i = 0; i < 4; i++) {
    const m = CD_PREFIX.exec(rest);
    if (!m) break;
    const raw = m[1] ?? "";
    dir = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") ? raw.slice(1, -1) : raw;
    rest = rest.slice(m[0].length);
  }
  return dir !== undefined && rest.trim() ? { dir, rest } : { rest: cmd };
}

/** `/Users/me/x` -> `~/x` for display (then masked). */
export function displayHome(p: string, userHome: string): string {
  const out = userHome && (p === userHome || p.startsWith(`${userHome}/`)) ? `~${p.slice(userHome.length)}` : p;
  return maskSecrets(out);
}

// ---------------------------------------------------------------------------
// Time buckets
// ---------------------------------------------------------------------------

/** Sparkline window: 30 one-minute buckets. */
export const ACTIVITY_BUCKETS = 30;
/** Per-minute activity older than this is not kept. */
export const ACTIVITY_KEEP_MIN = 60;
const MAX_TICKS = 4000;

/** Local calendar day key, e.g. "2026-09-29". */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Bucket per-minute counts into `n` minutes ending with the minute containing `now`. */
export function activityBuckets(minutes: Map<number, number>, now: number, n = ACTIVITY_BUCKETS): ActivityBuckets {
  const endMin = Math.floor(now / 60000);
  const counts = new Array<number>(n).fill(0);
  for (const [m, c] of minutes) {
    const i = n - 1 - (endMin - m);
    if (i >= 0 && i < n) counts[i] = (counts[i] ?? 0) + c;
  }
  return { end: endMin * 60000, counts };
}

/** Whole seconds after `start`, deduplicated and ascending; sampled down to `max` entries. */
export function tickOffsets(ticks: number[], start: number | undefined, max = MAX_TICKS): number[] {
  if (start === undefined || ticks.length === 0) return [];
  const set = new Set<number>();
  for (const t of ticks) set.add(Math.max(0, Math.round((t - start) / 1000)));
  let out = [...set].sort((a, b) => a - b);
  if (out.length > max) {
    const step = out.length / max;
    out = Array.from({ length: max }, (_, i) => out[Math.floor(i * step)] ?? 0);
  }
  return out;
}
