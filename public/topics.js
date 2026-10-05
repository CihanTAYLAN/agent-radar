// Konular: what work is being done, grouped semantically. Data: GET /api/topics.
// Two views: the compact list on the home screen, and one topic's agents across sessions.

import { h, fmtUsd, ago, fmtTime, stateLabel } from "./util.js";

const SHOWN = 8;

const shortMod = (m) => {
  const skip = new Set(["apps", "packages", "libs", "lib", "src", "modules", "app", "source"]);
  const segs = m.split("/").filter((s) => !skip.has(s));
  return (segs.length ? segs : m.split("/")).slice(-2).join("/");
};

/** The deterministic summary minus the parts the meta line already shows (agent counts). */
function quietSummary(t) {
  return (t.summary ?? "").split(" · ").filter((p) => !/^\d+ (ajan|çalışıyor|başarısız)$/.test(p) && !p.startsWith("modüller:")).join(" · ");
}

function metaLine(t) {
  const c = t.counts;
  const counts = [c.running ? `${c.running} çalışıyor` : "", c.done ? `${c.done} bitti` : "", c.failed ? `${c.failed} başarısız` : ""].filter(Boolean).join(" · ");
  return [t.project, counts, ago(t.lastAt), t.costUsd > 0 ? `~${fmtUsd(t.costUsd)}` : ""].filter(Boolean).join(" · ");
}

function topicRow(t, cursor, onOpen) {
  const running = t.counts.running > 0;
  const body = t.llmSummary ? t.llmSummary : quietSummary(t);
  const mods = t.modules.map(shortMod).join(" · ");
  return h("button", { class: `topic-row${cursor === t.id ? " cursor" : ""}`, role: "listitem", "data-id": t.id, onclick: () => onOpen(t.id) },
    h("span", { class: `dot ${running ? "running" : "done"}` }),
    h("span", { class: "topic-main" },
      h("span", { class: "topic-t" },
        t.key ? h("span", { class: "topic-key mono", text: t.key }) : null,
        h("span", { class: "topic-name", text: t.title, title: t.title })),
      h("span", { class: "topic-meta muted", text: metaLine(t) }),
      body ? h("span", { class: `topic-sum${t.llmSummary ? "" : " det"}`, title: body }, body, t.llmSummary ? h("span", { class: "topic-llm muted", text: " · model özeti" }) : null) : null,
      mods ? h("span", { class: "topic-mods muted mono", text: mods }) : null));
}

/** Home section. `root` receives the heading and the list. */
export function createTopicsList(root, { onOpen }) {
  const title = h("h1", { class: "home-h", text: "Konular" });
  const sub = h("div", { class: "home-sub muted" });
  const list = h("div", { class: "topic-list", role: "list" });
  const more = h("div", { class: "topic-more" });
  root.append(h("header", { class: "home-head" }, title, sub), list, more);
  let data = null;
  let all = false;
  let cursor = null;

  function render() {
    if (!data) {
      sub.textContent = "";
      list.replaceChildren(...Array.from({ length: 3 }, () => h("div", { class: "sk-row" }, h("i"), h("b", { class: "w1" }))));
      more.replaceChildren();
      return;
    }
    const topics = data.topics;
    sub.textContent = topics.length ? `${topics.length} konu · son ${Math.round(data.windowMs / 3600_000)} sa` : "";
    if (topics.length === 0) {
      list.replaceChildren(h("div", { class: "muted topic-empty", text: "Bu pencerede konu yok." }));
      more.replaceChildren();
      return;
    }
    const shown = all ? topics : topics.slice(0, SHOWN);
    list.replaceChildren(...shown.map((t) => topicRow(t, cursor, onOpen)));
    more.replaceChildren(topics.length > SHOWN
      ? h("button", { class: "today-btn", "aria-expanded": String(all), onclick: () => ((all = !all), render()) }, h("span", { text: all ? "Daha az göster" : `Tüm konular (${topics.length})` }))
      : "");
  }

  return {
    set(d) {
      data = d;
      render();
    },
    keys: () => [...list.querySelectorAll(".topic-row")].map((el) => el.getAttribute("data-id")),
    get cursor() {
      return cursor;
    },
    setCursor(id) {
      cursor = id;
      for (const el of list.querySelectorAll(".topic-row")) {
        const on = el.getAttribute("data-id") === id;
        el.classList.toggle("cursor", on);
        if (on) el.scrollIntoView({ block: "nearest" });
      }
    },
  };
}

/** One topic: identity, facts and its agents grouped by session. */
export function createTopicView(root, { onBack, onOpenAgent, onSession }) {
  let topic = null;
  let missing = false;

  function render() {
    if (!topic) {
      root.replaceChildren(
        h("button", { class: "topic-back muted", text: "← Konular", onclick: onBack }),
        h("div", { class: "home-empty" }, h("div", { class: "home-empty-t", text: missing ? "Konu bulunamadı" : "Yükleniyor…" }),
          missing ? h("div", { class: "muted", text: "Artık seçili zaman penceresinde olmayabilir." }) : null));
      return;
    }
    const t = topic;
    const bySession = new Map();
    for (const a of t.agents) {
      const g = bySession.get(a.sessionId) ?? { name: a.sessionName, agents: [] };
      g.agents.push(a);
      bySession.set(a.sessionId, g);
    }
    const body = t.llmSummary ?? "";
    const facts = [
      t.modules.length ? ["Modüller", t.modules.join("  ·  ")] : null,
      t.recent.length ? ["Son eylemler", t.recent.join("\n")] : null,
      ["Başladı", `${fmtTime(t.firstAt)} · son etkinlik ${ago(t.lastAt)}`],
    ].filter(Boolean);
    root.replaceChildren(
      h("button", { class: "topic-back muted", text: "← Konular", onclick: onBack }),
      h("header", { class: "home-head topic-head" },
        t.key ? h("span", { class: "topic-key mono", text: t.key }) : null,
        h("h1", { class: "home-h", text: t.title })),
      h("div", { class: "topic-meta muted", text: metaLine(t) }),
      body ? h("p", { class: "topic-sum wrap" }, body, t.llmSummary ? h("span", { class: "topic-llm muted", text: " · model özeti" }) : null) : null,
      h("dl", { class: "topic-facts" }, ...facts.flatMap(([k, v]) => [h("dt", { class: "muted", text: k }), h("dd", { class: k === "Başladı" ? "" : "mono", text: v })])),
      ...[...bySession.entries()].map(([sid, g]) =>
        h("section", { class: "home-group" },
          h("button", { class: "home-group-h", onclick: () => onSession(sid) }, h("span", { class: "home-group-t", text: g.name }), h("span", { class: "muted", text: `${g.agents.length} ajan` })),
          ...g.agents.map((a) =>
            h("button", { class: "home-row topic-agent", "data-id": `${sid}|${a.key}`, onclick: () => onOpenAgent(sid, a.key) },
              h("span", { class: `dot ${a.state}` }),
              h("span", { class: "home-name", text: a.label, title: a.label }),
              h("span", { class: `act muted${a.state === "failed" ? " bad" : ""}`, text: stateLabel(a.state) }),
              h("span", { class: "home-dur num", text: ago(a.lastActivityAt) }))))));
  }

  return {
    set(d, id) {
      topic = d?.topics.find((x) => x.id === id) ?? null;
      missing = Boolean(d) && !topic;
      render();
    },
    clear() {
      topic = null;
      missing = false;
      root.replaceChildren();
    },
  };
}
