/**
 * pricing.ts -- the ONE place for cost estimates.
 *
 * Prices are ESTIMATES in USD per million tokens and are not read from any bill or API. Every model
 * (Claude and OpenAI alike) is matched EXACTLY by pattern, never by substring ("gpt-5.6-luna" is not
 * "gpt-5", "claude-opus-5" is not "claude-opus-5-5"). Entries are unverified unless they carry
 * `verified: true` + `source` (official page, standard tier only -- see the *_PRICING_NOTEs). An
 * unknown model has no price at all (claudePrice()/openAiPrice() -> undefined, shown as "—" with
 * costPartial): nothing is guessed silently.
 */
import type { Usage } from "./providers/types.js";

export interface Price {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** Cache write (Claude: the 5-minute rate). */
  cacheWrite: number;
  cacheRead: number;
  /** Claude only: 1-hour cache write rate (used for Usage.cacheCreate1h; falls back to cacheWrite). */
  cacheWrite1h?: number;
}

// ---------------------------------------------------------------------------
// OpenAI / Codex estimates
// ---------------------------------------------------------------------------

export interface ModelPrice extends Price {
  /** Display id of the entry. */
  model: string;
  provider: string;
  /** False: copied from public list prices at some point, not checked against a bill. */
  verified: boolean;
  /** Where a verified price was read, e.g. "OpenAI, 2026-09-29". Absent when unverified. */
  source?: string;
}

interface OpenAiEntry {
  re: RegExp;
  price: ModelPrice;
}

/** OpenAI bills cache writes as normal input; cached input is discounted. */
const oai = (model: string, input: number, cachedInput: number, output: number): ModelPrice => ({
  model,
  provider: "codex",
  verified: false,
  input,
  output,
  cacheWrite: input,
  cacheRead: cachedInput,
});

const OFFICIAL_SOURCE = "OpenAI, 2026-09-29";

/**
 * Verified entry from https://developers.openai.com/api/docs/pricing (Standard tier, fetched
 * 2026-09-29). `cacheWrite` is the listed cache-write price; when the page lists none ("—"), cache
 * writes are billed as plain input, same as oai() does for the unverified entries.
 * Long-context (>272k input tokens/request) prices are NOT applied.
 */
const official = (model: string, input: number, cachedInput: number, cacheWrite: number | undefined, output: number): ModelPrice => ({
  ...oai(model, input, cachedInput, output),
  cacheWrite: cacheWrite ?? input,
  verified: true,
  source: OFFICIAL_SOURCE,
});

const DATE = "(?:-\\d{4}-\\d{2}-\\d{2})?";
const OPENAI: OpenAiEntry[] = [
  // Official, verified (exact ids; optional date suffix). ^...$ keeps -codex-spark etc. out.
  { re: new RegExp(`^gpt-6-astra${DATE}$`), price: official("gpt-6-astra", 10, 1, 12.5, 50) },
  { re: new RegExp(`^gpt-6-sol${DATE}$`), price: official("gpt-6-sol", 2, 0.2, 2.5, 10) },
  { re: new RegExp(`^gpt-6-luna${DATE}$`), price: official("gpt-6-luna", 0.1, 0.01, 0.125, 0.5) },
  { re: new RegExp(`^gpt-5\\.6-sol${DATE}$`), price: official("gpt-5.6-sol", 4, 0.4, 5, 20) },
  { re: new RegExp(`^gpt-5\\.6-terra${DATE}$`), price: official("gpt-5.6-terra", 2, 0.2, 2.5, 12) },
  { re: new RegExp(`^gpt-5\\.6-luna${DATE}$`), price: official("gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2) },
  { re: new RegExp(`^gpt-5\\.5${DATE}$`), price: official("gpt-5.5", 5, 0.5, undefined, 30) },
  { re: new RegExp(`^gpt-5\\.4${DATE}$`), price: official("gpt-5.4", 2.5, 0.25, undefined, 15) },
  { re: new RegExp(`^gpt-5\\.4-mini${DATE}$`), price: official("gpt-5.4-mini", 0.75, 0.075, undefined, 4.5) },
  { re: new RegExp(`^gpt-5\\.3-codex${DATE}$`), price: official("gpt-5.3-codex", 1.75, 0.175, undefined, 14) },
  // Older entries: unverified. (gpt-5.3-codex-spark and gpt-5.2-codex are not on the official page: no price.)
  { re: new RegExp(`^gpt-5(?:-codex)?${DATE}$`), price: oai("gpt-5 / gpt-5-codex", 1.25, 0.125, 10) },
  { re: new RegExp(`^gpt-5\\.1(?:-codex)?${DATE}$`), price: oai("gpt-5.1 / gpt-5.1-codex", 1.25, 0.125, 10) },
  { re: new RegExp(`^gpt-5(?:\\.1)?-codex-mini${DATE}$`), price: oai("gpt-5-codex-mini", 0.25, 0.025, 2) },
  { re: new RegExp(`^gpt-5-mini${DATE}$`), price: oai("gpt-5-mini", 0.25, 0.025, 2) },
  { re: new RegExp(`^gpt-5-nano${DATE}$`), price: oai("gpt-5-nano", 0.05, 0.005, 0.4) },
  { re: new RegExp(`^gpt-4\\.1${DATE}$`), price: oai("gpt-4.1", 2, 0.5, 8) },
  { re: new RegExp(`^gpt-4\\.1-mini${DATE}$`), price: oai("gpt-4.1-mini", 0.4, 0.1, 1.6) },
  { re: new RegExp(`^o3${DATE}$`), price: oai("o3", 2, 0.5, 8) },
  { re: new RegExp(`^o4-mini${DATE}$`), price: oai("o4-mini", 1.1, 0.275, 4.4) },
  { re: /^codex-mini-latest$/, price: oai("codex-mini-latest", 1.5, 0.375, 6) },
];

export const OPENAI_PRICING_NOTE = 
  "OpenAI: \"doğrulandı\" işaretli satırlar resmi fiyat sayfasındandır (Standard katman); diğer girdiler tahminidir ve doğrulanmadı. " +
  "Tabloda olmayan modeller için maliyet gösterilmez (—); uzun bağlam (>272k) fiyatı uygulanmıyor; gerçek maliyet biraz daha yüksek olabilir.";

/** Estimate entry for an OpenAI model id, or undefined when unknown (no guessing). */
export function openAiPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase().replace(/^openai\//, "");
  return OPENAI.find((e) => e.re.test(m))?.price;
}

/** USD for one model's usage, or undefined when the model has no known price. */
export function openAiCostUsd(model: string | undefined, u: Usage): number | undefined {
  return costWith(openAiPrice(model), u);
}

// ---------------------------------------------------------------------------
// Claude (Anthropic) -- official per-model prices
// ---------------------------------------------------------------------------

const CLAUDE_SOURCE = "Anthropic, 2026-09-29";

/**
 * Verified entry from https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-09-29),
 * base tier: [base input, 5m cache write, 1h cache write, cache read, output].
 */
const anthropic = (model: string, input: number, write5m: number, write1h: number, cacheRead: number, output: number): ModelPrice => ({
  model,
  provider: "claude-code",
  verified: true,
  source: CLAUDE_SOURCE,
  input,
  output,
  cacheWrite: write5m,
  cacheWrite1h: write1h,
  cacheRead,
});

/** Optional `-YYYYMMDD` snapshot suffix (claude-haiku-4-5-20251001). */
const SNAP = "(?:-\\d{8})?";
const claudeRe = (id: string) => new RegExp(`^${id}${SNAP}$`);
const CLAUDE: OpenAiEntry[] = [
  { re: claudeRe("claude-fable-5-1"), price: anthropic("claude-fable-5-1", 10, 12.5, 20, 0.25, 50) },
  { re: claudeRe("claude-fable-5"), price: anthropic("claude-fable-5", 10, 12.5, 20, 1, 50) },
  { re: claudeRe("claude-mythos-5-1"), price: anthropic("claude-mythos-5-1", 10, 12.5, 20, 0.25, 50) },
  { re: claudeRe("claude-mythos-5"), price: anthropic("claude-mythos-5", 10, 12.5, 20, 1, 50) },
  { re: claudeRe("claude-opus-5-5"), price: anthropic("claude-opus-5-5", 4, 5, 8, 0.2, 20) },
  { re: claudeRe("claude-opus-5"), price: anthropic("claude-opus-5", 5, 6.25, 10, 0.5, 25) },
  { re: claudeRe("claude-opus-4-[5-8]"), price: anthropic("claude-opus-4-8 / 4-7 / 4-6 / 4-5", 5, 6.25, 10, 0.5, 25) },
  { re: claudeRe("claude-opus-4-1"), price: anthropic("claude-opus-4-1", 15, 18.75, 30, 1.5, 75) },
  { re: claudeRe("claude-opus-4"), price: anthropic("claude-opus-4", 15, 18.75, 30, 1.5, 75) },
  { re: claudeRe("claude-sonnet-5-5"), price: anthropic("claude-sonnet-5-5", 2, 2.5, 4, 0.2, 10) },
  { re: claudeRe("claude-sonnet-5"), price: anthropic("claude-sonnet-5", 2, 2.5, 4, 0.2, 10) },
  { re: claudeRe("claude-sonnet-4(?:-[56])?"), price: anthropic("claude-sonnet-4-6 / 4-5 / 4", 3, 3.75, 6, 0.3, 15) },
  { re: claudeRe("claude-haiku-4-5"), price: anthropic("claude-haiku-4-5", 1, 1.25, 2, 0.1, 5) },
  { re: claudeRe("claude-(?:haiku-3-5|3-5-haiku)"), price: anthropic("claude-haiku-3-5", 0.8, 1, 1.6, 0.08, 4) },
];

export const CLAUDE_PRICING_NOTE =
  "Claude: fiyatlar Anthropic resmi fiyat sayfasındandır (2026-09-29, standart katman); önbellek yazması 5 dk / 1 sa oranlarıyla ayrı hesaplanır. " +
  "Hızlı mod (fast), toplu iş (batch, −%50) ve ABD veri yerleşimi (×1,1) çarpanları uygulanmaz; bunlar kullanılmışsa gerçek maliyet farklı olabilir. " +
  "Tabloda olmayan modeller (ör. takma ad olan \"sonnet\") için maliyet gösterilmez (—).";

/** Strips a provider prefix and a bracket suffix ("[1m]") Claude Code may append. */
function claudeId(model: string): string {
  return model.trim().toLowerCase().replace(/^anthropic\//, "").replace(/\[[^\]]*\]$/, "");
}

/** Price entry for a Claude model id, or undefined when unknown (no guessing). */
export function claudePrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const m = claudeId(model);
  return CLAUDE.find((e) => e.re.test(m))?.price;
}

/** USD for one model's usage, or undefined when the model has no known price. */
export function claudeCostUsd(model: string | undefined, u: Usage): number | undefined {
  return costWith(claudePrice(model), u);
}

/** Cost of a usage under one price; the 1h share of cache writes (Usage.cacheCreate1h) uses the 1h rate. */
function costWith(p: Price | undefined, u: Usage): number | undefined {
  if (!p) return undefined;
  const w1h = Math.min(u.cacheCreate1h ?? 0, u.cacheCreate);
  return (u.input * p.input + u.output * p.output + (u.cacheCreate - w1h) * p.cacheWrite + w1h * (p.cacheWrite1h ?? p.cacheWrite) + u.cacheRead * p.cacheRead) / 1e6;
}

/** Claude cost of a model -> usage map; `partial` when some non-empty usage has no known price. */
export function claudeCostOfModels(byModel: Iterable<[string, Usage]>): { cost: number; partial: boolean } {
  let cost = 0;
  let partial = false;
  for (const [m, u] of byModel) {
    if (u.input + u.output + u.cacheRead + u.cacheCreate === 0) continue;
    const c = claudeCostUsd(m, u);
    if (c === undefined) partial = true;
    else cost += c;
  }
  return { cost, partial };
}

/** All price rows (Claude first, then OpenAI; verified + unverified), for /api/pricing. */
export const ESTIMATES: ModelPrice[] = [...CLAUDE, ...OPENAI].map((e) => e.price);

/**
 * Generate a pricing note for the Codex provider status, based on models ACTUALLY SEEN by the provider.
 * @param seen Lists of verified and estimated OpenAI models observed in this machine's sessions.
 * Returns a Turkish note describing the pricing verification status for seen models.
 */
export function codexPricingNote(seen: { verified: string[]; estimated: string[] }): string {
  const verifiedCount = seen.verified.length;
  const estimatedCount = seen.estimated.length;

  // All seen priced models are verified.
  if (verifiedCount > 0 && estimatedCount === 0) {
    return "Maliyet: OpenAI resmi fiyatları (2026-09-29, standart katman)";
  }

  // Mix of verified and estimated: list up to 4 estimated names.
  if (estimatedCount > 0) {
    const listed = seen.estimated.slice(0, 4).join(", ");
    return `Maliyet: OpenAI resmi fiyatları (2026-09-29, standart katman) · tahmini: ${listed}${estimatedCount > 4 ? ` +${estimatedCount - 4}` : ""}.`;
  }

  // No priced OpenAI models seen (all models are unknown or non-OpenAI).
  return "Maliyet: OpenAI fiyat tablosu (resmi, 2026-09-29)";
}
