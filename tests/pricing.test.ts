import { describe, expect, it } from "vitest";
import { ESTIMATES, claudeCostOfModels, claudeCostUsd, claudePrice, codexPricingNote, openAiCostUsd, openAiPrice } from "../src/pricing.js";

const M = 1_000_000;

describe("official Claude prices (Anthropic, 2026-09-29)", () => {
  // [id, input, 5m write, 1h write, cache read, output]
  const table: Array<[string, number, number, number, number, number]> = [
    ["claude-fable-5-1", 10, 12.5, 20, 0.25, 50],
    ["claude-fable-5", 10, 12.5, 20, 1, 50],
    ["claude-mythos-5-1", 10, 12.5, 20, 0.25, 50],
    ["claude-mythos-5", 10, 12.5, 20, 1, 50],
    ["claude-opus-5-5", 4, 5, 8, 0.2, 20],
    ["claude-opus-5", 5, 6.25, 10, 0.5, 25],
    ["claude-opus-4-8", 5, 6.25, 10, 0.5, 25],
    ["claude-opus-4-7", 5, 6.25, 10, 0.5, 25],
    ["claude-opus-4-6", 5, 6.25, 10, 0.5, 25],
    ["claude-opus-4-5", 5, 6.25, 10, 0.5, 25],
    ["claude-opus-4-1", 15, 18.75, 30, 1.5, 75],
    ["claude-opus-4", 15, 18.75, 30, 1.5, 75],
    ["claude-sonnet-5-5", 2, 2.5, 4, 0.2, 10],
    ["claude-sonnet-5", 2, 2.5, 4, 0.2, 10],
    ["claude-sonnet-4-6", 3, 3.75, 6, 0.3, 15],
    ["claude-sonnet-4-5", 3, 3.75, 6, 0.3, 15],
    ["claude-sonnet-4", 3, 3.75, 6, 0.3, 15],
    ["claude-haiku-4-5", 1, 1.25, 2, 0.1, 5],
    ["claude-haiku-3-5", 0.8, 1, 1.6, 0.08, 4],
  ];
  it.each(table)("%s resolves to its verified price (also with date, prefix and [1m] variants)", (id, input, w5m, w1h, read, output) => {
    for (const v of [id, `${id}-20251001`, `${id}[1m]`, `anthropic/${id}`, id.toUpperCase(), `${id}-20251001[1m]`]) {
      expect(claudePrice(v), v).toMatchObject({ input, cacheWrite: w5m, cacheWrite1h: w1h, cacheRead: read, output, verified: true, source: "Anthropic, 2026-09-29" });
    }
  });
  it("keeps prefix-adjacent ids apart", () => {
    expect(claudePrice("claude-opus-5")?.output).toBe(25);
    expect(claudePrice("claude-opus-5-5")?.output).toBe(20);
    expect(claudePrice("claude-opus-5-5-20260101")?.output).toBe(20);
    expect(claudePrice("claude-sonnet-5")?.input).toBe(2);
    expect(claudePrice("claude-sonnet-5-5")?.input).toBe(2);
    expect(claudePrice("claude-sonnet-5-5")?.model).toBe("claude-sonnet-5-5");
    expect(claudePrice("claude-opus-4")?.output).toBe(75);
    expect(claudePrice("claude-opus-4-1")?.output).toBe(75);
    expect(claudePrice("claude-opus-4-8")?.output).toBe(25);
    expect(claudePrice("claude-fable-5")?.cacheRead).toBe(1);
    expect(claudePrice("claude-fable-5-1")?.cacheRead).toBe(0.25);
  });
  it("does not price unknown Claude ids or bare aliases", () => {
    for (const id of ["opus", "sonnet", "haiku", "unknown", "claude-opus-6", "claude-opus-5-9", "claude-sonnet-5-5-x", "claude-fable-6", "claude-opus-4-9", "gpt-5", ""]) {
      expect(claudePrice(id), id).toBeUndefined();
      expect(claudeCostUsd(id, { input: M, output: M, cacheCreate: M, cacheRead: M }), id).toBeUndefined();
    }
    expect(claudePrice(undefined)).toBeUndefined();
  });
  it("prices every token class separately, 5m and 1h cache writes apart", () => {
    // claude-sonnet-5: 2 in + 10 out + 2.5 (5m write) + 0.2 read
    expect(claudeCostUsd("claude-sonnet-5", { input: M, output: M, cacheCreate: M, cacheRead: M })).toBeCloseTo(2 + 10 + 2.5 + 0.2, 10);
    // 3M cache writes, of which 1M with 1h TTL: 2M*2.5 + 1M*4
    expect(claudeCostUsd("claude-sonnet-5", { input: 0, output: 0, cacheCreate: 3 * M, cacheCreate1h: M, cacheRead: 0 })).toBeCloseTo(5 + 4, 10);
    // all 1h; a 1h share above the total is capped
    expect(claudeCostUsd("claude-opus-5", { input: 0, output: 0, cacheCreate: M, cacheCreate1h: 5 * M, cacheRead: 0 })).toBeCloseTo(10, 10);
    expect(claudeCostUsd("claude-opus-5-5", { input: 0, output: 2 * M, cacheCreate: 0, cacheRead: 10 * M })).toBeCloseTo(40 + 2, 10);
    expect(claudeCostUsd("claude-fable-5-1", { input: M, output: M, cacheCreate: M, cacheRead: M })).toBeCloseTo(10 + 50 + 12.5 + 0.25, 10);
  });
  it("sums a model map and flags unpriced usage as partial", () => {
    const u = { input: 0, output: M, cacheCreate: 0, cacheRead: 0 };
    expect(claudeCostOfModels([["claude-haiku-4-5", u], ["claude-sonnet-5", u]])).toEqual({ cost: 15, partial: false });
    const mixed = claudeCostOfModels([["claude-sonnet-5", u], ["sonnet", u], ["claude-opus-5", { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }]]);
    expect(mixed.cost).toBeCloseTo(10, 10);
    expect(mixed.partial).toBe(true);
    expect(claudeCostOfModels([["nope", { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }]])).toEqual({ cost: 0, partial: false });
  });
  it("lists Claude and OpenAI rows in ESTIMATES with their provider", () => {
    const claude = ESTIMATES.filter((e) => e.provider === "claude-code");
    expect(claude.length).toBe(14);
    expect(claude.every((e) => e.verified && e.source === "Anthropic, 2026-09-29")).toBe(true);
    expect(ESTIMATES.some((e) => e.provider === "codex")).toBe(true);
  });
});

describe("official OpenAI prices (2026-09-29, Standard tier)", () => {
  // [id, input, cached, cacheWrite, output]; cacheWrite = input when the page lists none.
  const table: Array<[string, number, number, number, number]> = [
    ["gpt-6-astra", 10, 1, 12.5, 50],
    ["gpt-6-sol", 2, 0.2, 2.5, 10],
    ["gpt-6-luna", 0.1, 0.01, 0.125, 0.5],
    ["gpt-5.6-sol", 4, 0.4, 5, 20],
    ["gpt-5.6-terra", 2, 0.2, 2.5, 12],
    ["gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2],
    ["gpt-5.5", 5, 0.5, 5, 30],
    ["gpt-5.4", 2.5, 0.25, 2.5, 15],
    ["gpt-5.4-mini", 0.75, 0.075, 0.75, 4.5],
    ["gpt-5.3-codex", 1.75, 0.175, 1.75, 14],
  ];
  it.each(table)("%s resolves to its verified price", (id, input, cached, cacheWrite, output) => {
    for (const variant of [id, `openai/${id}`, id.toUpperCase(), `${id}-2026-09-29`]) {
      const p = openAiPrice(variant);
      expect(p, variant).toMatchObject({ model: id, input, cacheRead: cached, cacheWrite, output, verified: true, source: "OpenAI, 2026-09-29" });
    }
  });
  it("does not price ids that are not on the official page", () => {
    for (const id of ["gpt-5.3-codex-spark", "gpt-5.2-codex", "gpt-5.6", "gpt-6", "gpt-6-sol-mini", "gpt-5.6-sol-x", "gpt-5.4-nano"]) {
      expect(openAiPrice(id), id).toBeUndefined();
      expect(openAiCostUsd(id, { input: M, output: M, cacheCreate: 0, cacheRead: 0 }), id).toBeUndefined();
    }
  });
  it("keeps the old gpt-5.1-codex-mini estimate unverified", () => {
    const p = openAiPrice("gpt-5.1-codex-mini");
    expect(p?.verified).toBe(false);
    expect(p?.source).toBeUndefined();
  });
  it("keeps prefix-adjacent ids apart", () => {
    expect(openAiPrice("gpt-5.4")?.model).toBe("gpt-5.4");
    expect(openAiPrice("gpt-5.4-mini")?.model).toBe("gpt-5.4-mini");
    expect(openAiPrice("gpt-5.3-codex")?.model).toBe("gpt-5.3-codex");
  });
  it("costs gpt-6-sol usage per token class (standard tier)", () => {
    // 2M input*2 + 10M cached*0.2 + 1M cache write*2.5 + 0.5M output*10 = 4 + 2 + 2.5 + 5
    expect(openAiCostUsd("gpt-6-sol", { input: 2 * M, cacheRead: 10 * M, cacheCreate: M, output: 0.5 * M })).toBeCloseTo(13.5, 10);
  });
  it("falls back to input price for cache writes when none is listed", () => {
    expect(openAiCostUsd("gpt-5.5", { input: 0, output: 0, cacheCreate: M, cacheRead: 0 })).toBeCloseTo(5, 10);
  });
});

describe("codexPricingNote (Codex provider status pricing note)", () => {
  it("returns official pricing note when only verified models are seen", () => {
    const note = codexPricingNote({ verified: ["gpt-5.5", "gpt-6-sol"], estimated: [] });
    expect(note).toBe("Maliyet: OpenAI resmi fiyatları (2026-09-29, standart katman)");
  });

  it("returns pricing note with estimated models when both verified and estimated are seen", () => {
    const note = codexPricingNote({ verified: ["gpt-5.5"], estimated: ["gpt-5-mini", "o3"] });
    expect(note).toContain("Maliyet: OpenAI resmi fiyatları (2026-09-29, standart katman)");
    expect(note).toContain("tahmini: gpt-5-mini, o3");
  });

  it("lists up to 4 estimated models and indicates count of others", () => {
    const many = ["gpt-5-mini", "o3", "gpt-4.1", "o4-mini", "gpt-5-nano"];
    const note = codexPricingNote({ verified: [], estimated: many });
    expect(note).toContain("tahmini: gpt-5-mini, o3, gpt-4.1, o4-mini");
    expect(note).toContain("+1");
  });

  it("returns pricing table note when no priced models are seen", () => {
    const note = codexPricingNote({ verified: [], estimated: [] });
    expect(note).toBe("Maliyet: OpenAI fiyat tablosu (resmi, 2026-09-29)");
  });
});
