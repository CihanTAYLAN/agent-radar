// Home: "Şu an ne oluyor?" -- every running agent across all sessions and tools, grouped by session,
// then one expandable line for what finished today. Data: GET /api/now.

import { h, icon, ACTION, fmtDur, ago, fmtTime, lastSeg, actionTarget, providerInfo } from "./util.js";

const TODAY_SHOWN = 40;

export function createHome(root, { onOpen, onSession }) {
  const title = h("h2", { class: "home-h sec", text: "Şu an" });
  const sub = h("div", { class: "home-sub muted" });
  const list = h("div", { class: "home-list", role: "list" });
  const today = h("div", { class: "home-today" });
  root.append(h("header", { class: "home-head" }, title, sub), list, today);

  let data = null;
  let todayOpen = false;
  let cursor = null;
  const timers = []; // [el, startedAt]

  function actionLine(a) {
    if (a.state === "stalled") return h("span", { class: "act warn", text: `Sessiz · son etkinlik ${ago(a.lastActivityAt)}` });
    const la = a.lastAction;
    if (!la) return h("span", { class: "act muted", text: "Düşünüyor…" });
    const verb = (ACTION[la.kind] ?? ACTION.other).verb;
    return h("span", { class: "act", title: la.target ?? "" }, h("span", { class: "act-verb", text: verb }), h("span", { class: "act-target mono", text: actionTarget(la) }));
  }

  function render() {
    timers.length = 0;
    if (!data) {
      sub.textContent = "";
      list.replaceChildren(...Array.from({ length: 4 }, () => h("div", { class: "sk-row" }, h("i"), h("b", { class: "w1" }))));
      today.replaceChildren();
      return;
    }
    const total = data.running.reduce((n, g) => n + g.agents.length, 0);
    // The top bar already says how many agents run; here only the session count adds information.
    sub.textContent = total ? `${data.running.length} oturumda` : "";
    // Stable group order (busiest first) so the list does not reshuffle on every event.
    const groups = [...data.running].sort((a, b) => b.agents.length - a.agents.length || a.sessionName.localeCompare(b.sessionName, "tr"));
    if (total === 0) {
      list.replaceChildren(h("div", { class: "home-empty" },
        h("div", { class: "home-empty-t", text: "Şu an çalışan ajan yok" }),
        h("div", { class: "muted", text: data.lastActivityAt ? `Son etkinlik ${ago(data.lastActivityAt)} (${fmtTime(data.lastActivityAt)}).` : "Henüz etkinlik yok." })));
    } else {
      list.replaceChildren(...groups.map((g) => {
        const rows = g.agents.map((a) => {
          const id = `${g.sessionId}|${a.key}`;
          const el = h("button", { class: `home-row${a.state === "stalled" ? " stalled" : ""}${cursor === id ? " cursor" : ""}`, role: "listitem", "data-id": id, onclick: () => onOpen(g.sessionId, a.key) },
            h("span", { class: `dot ${a.state}` }),
            h("span", { class: "home-name", text: a.label, title: a.agentType && a.key !== "main" ? `${a.label} · ${a.agentType}` : a.label }),
            actionLine(a),
            h("span", { class: "home-dur num" }));
          timers.push([el.lastChild, a.startedAt]);
          return el;
        });
        return h("section", { class: "home-group" },
          h("button", { class: "home-group-h", title: `${providerInfo(g.provider).label} · ${g.cwd}`, onclick: () => onSession(g.sessionId) },
            h("span", { class: "home-group-t", text: g.sessionName }), h("span", { class: "muted", text: lastSeg(g.cwd) })),
          ...rows);
      }));
    }
    renderToday();
    tick(Date.now());
  }

  function renderToday() {
    const t = data.today;
    if (t.done + t.failed === 0) return today.replaceChildren(h("div", { class: "muted", text: "Bugün tamamlanan ajan yok." }));
    const btn = h("button", { class: "today-btn", "aria-expanded": String(todayOpen), onclick: () => ((todayOpen = !todayOpen), renderToday()) },
      h("span", { class: "num", text: `Bugün tamamlanan ${t.done}` }),
      t.failed ? h("span", { class: "bad num", text: ` · başarısız ${t.failed}` }) : null,
      icon(todayOpen ? "chevronDown" : "chevronRight"));
    const items = todayOpen
      ? h("div", { class: "today-list" }, ...t.items.slice(0, TODAY_SHOWN).map((it) =>
          h("button", { class: "today-row", onclick: () => onOpen(it.sessionId, it.key), title: it.endReason ?? "" },
            h("span", { class: `dot ${it.state}` }),
            h("span", { class: "home-name", text: it.label }),
            h("span", { class: "muted today-sess", text: it.state === "failed" && it.endReason ? it.endReason : it.sessionName }),
            h("span", { class: "home-dur num muted", text: fmtTime(it.endedAt) }))),
          t.done + t.failed > TODAY_SHOWN ? h("div", { class: "today-more muted num", text: `ve ${t.done + t.failed - TODAY_SHOWN} ajan daha` }) : null)
      : null;
    today.replaceChildren(btn, items ?? "");
  }

  function tick(now) {
    for (const [el, since] of timers) el.textContent = since ? fmtDur(now - since) : "";
  }

  const ids = () => [...list.querySelectorAll(".home-row")].map((el) => el.getAttribute("data-id"));

  return {
    set(d) {
      data = d;
      render();
    },
    tick,
    keys: ids,
    get cursor() {
      return cursor;
    },
    setCursor(id) {
      cursor = id;
      for (const el of list.querySelectorAll(".home-row")) {
        const on = el.getAttribute("data-id") === id;
        el.classList.toggle("cursor", on);
        if (on) el.scrollIntoView({ block: "nearest" });
      }
    },
    openCursor() {
      if (!cursor) return false;
      const [sid, key] = cursor.split("|");
      onOpen(sid, key);
      return true;
    },
  };
}
