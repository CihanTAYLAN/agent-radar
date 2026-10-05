// Maliyet: one headline number, one bar list per agent and one per model. The price table sits behind a
// disclosure. Plain CSS bars, no chart library.

import { h, fmtUsd, fmtCost, fmtTok, shortModel, flatten, stateLabel, providerInfo } from "./util.js";

const TOP = 12;

export function createCostView(root, { onOpen }) {
  let pricing = null;
  let showAll = false;
  let last = null;

  function render(d) {
    last = d;
    if (!d) return root.replaceChildren();
    const pv = providerInfo(d.provider);
    if (!pv.caps.tokens) {
      return root.replaceChildren(h("div", { class: "cost-wrap" }, h("p", { class: "muted", text: `${pv.label} token bilgisi sağlamıyor; maliyet tahmini yapılamaz.` })));
    }
    const nodes = flatten(d.tree).map((x) => x.node);
    const main = nodes.find((n) => n.key === "main");
    const subCost = nodes.reduce((c, n) => c + (n.key === "main" ? 0 : n.costUsd), 0);
    // Nothing priced at all (e.g. unknown models): rank by tokens instead of dollars.
    const byTokens = d.costPartial && d.costUsd === 0;
    const metric = (n) => (byTokens ? n.totalTokens : n.costUsd);
    const unpriced = Object.entries(d.costByModel ?? {}).filter(([, c]) => c === null).map(([m]) => shortModel(m));

    const headline = h("header", { class: "cost-head" },
      h("div", { class: "cost-big num", text: byTokens ? fmtTok(d.totalTokens) : fmtCost(d) }),
      h("div", { class: "muted", text: byTokens
        ? "token · bu oturumdaki modellerin fiyatı bilinmiyor"
        : `tahmini · ana ajan ${fmtUsd(main?.costUsd ?? 0)} · alt ajanlar ${fmtUsd(subCost)}${unpriced.length ? ` · fiyatı bilinmeyen: ${unpriced.join(", ")}` : ""}` }));

    const ranked = [...nodes].sort((a, b) => metric(b) - metric(a));
    const maxA = Math.max(1e-9, ranked[0] ? metric(ranked[0]) : 0);
    const agents = ranked.slice(0, showAll ? ranked.length : TOP).map((n) =>
      barRow(n.key === "main" ? "Ana ajan" : n.label, byTokens ? fmtTok(n.totalTokens) : fmtCost(n), metric(n) / maxA, { title: stateLabel(n.state), onclick: () => onOpen(n.key) }));
    const toggle = ranked.length > TOP ? h("button", { class: "link", text: showAll ? `İlk ${TOP}` : `Tümü (${ranked.length})`, onclick: () => ((showAll = !showAll), render(last)) }) : null;

    const tot = (u) => u.input + u.output + u.cacheRead + u.cacheCreate;
    const models = Object.entries(d.usageByModel).map(([m, u]) => ({ m, c: d.costByModel?.[m] ?? null, t: tot(u) })).map((x) => ({ ...x, v: byTokens ? x.t : x.c ?? 0 })).sort((a, b) => b.v - a.v);
    const maxM = Math.max(1e-9, ...models.map((x) => x.v));
    const modelRows = models.map(({ m, c, t, v }) => barRow(shortModel(m) || m, byTokens ? fmtTok(t) : c === null ? "—" : fmtUsd(c), v / maxM, { title: c === null ? "Fiyat bilinmiyor" : `${fmtTok(t)} token` }));

    const rows = (pricing?.estimates ?? []).filter((e) => e.provider === d.provider);
    const prices = h("details", { class: "disclosure" }, h("summary", { text: "Fiyat tablosu" }),
      h("p", { class: "muted", text: pricing?.notes?.[d.provider] ?? pricing?.note ?? "Tahmini fiyatlar; src/pricing.ts içinden düzenlenebilir." }),
      rows.length ? priceTable(rows) : h("p", { class: "muted", text: pricing ? "Bu araç için fiyat tablosu yok." : "Yükleniyor…" }));

    root.replaceChildren(h("div", { class: "cost-wrap" }, headline,
      h("div", { class: "cost-cols" },
        h("section", null, h("h3", { class: "sec-h" }, h("span", { text: "Ajana göre" }), h("span", { class: "grow" }), toggle), h("div", { class: "bars" }, ...agents)),
        h("section", null, h("h3", { class: "sec-h", text: "Modele göre" }), h("div", { class: "bars" }, ...modelRows))),
      prices));
  }

  return {
    render,
    setPricing(p) {
      pricing = p;
      if (last) render(last);
    },
  };
}

function barRow(label, value, frac, { title, onclick } = {}) {
  const fill = h("div", { class: "bar-fill" });
  fill.style.width = `${Math.max(0.5, frac * 100).toFixed(2)}%`;
  return h(onclick ? "button" : "div", { class: "bar-row", title, onclick },
    h("span", { class: "bar-label", text: label }), h("span", { class: "bar-value num", text: value }), h("div", { class: "bar-track" }, fill));
}

function priceTable(rows) {
  const has1h = rows.some((e) => e.cacheWrite1h !== undefined);
  const cols = [["input", "Giriş"], ["output", "Çıktı"], ...(has1h ? [["cacheWrite", "Önb. yazma 5dk"], ["cacheWrite1h", "Önb. yazma 1sa"]] : []), ["cacheRead", "Önb. okuma"]];
  const usd = (v) => `$${String(v).replace(".", ",")}`;
  return h("table", { class: "price-table" },
    h("thead", null, h("tr", null, h("th", { text: "Model" }), ...cols.map(([, t]) => h("th", { text: t })))),
    h("tbody", null, ...rows.map((e) => h("tr", null,
      h("td", { class: "mono", title: e.verified ? `Doğrulandı · ${e.source ?? ""}` : "Doğrulanmadı" }, h("span", { text: e.model }), e.verified ? null : h("span", { class: "warn", text: " *" })),
      ...cols.map(([k]) => h("td", { class: "num", text: e[k] === undefined ? "—" : usd(e[k]) }))))),
    h("caption", { class: "muted", text: "USD / 1M token · standart katman · * doğrulanmadı" }));
}
