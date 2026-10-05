// ⌘K command palette: jump to any session, any agent of the current session, or run a command.

import { h, icon, trLower, stateLabel, shortModel, lastSeg, ago, providerInfo } from "./util.js";

export function createPalette({ getItems }) {
  const input = h("input", { class: "pal-input", type: "text", placeholder: "Oturum, ajan veya komut ara…", autocomplete: "off", spellcheck: false, "aria-label": "Komut paleti", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list" });
  const list = h("div", { class: "pal-list", id: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" },
    h("span", null, h("kbd", { text: "↑" }), h("kbd", { text: "↓" }), " gezin"),
    h("span", null, h("kbd", { text: "↵" }), " aç"),
    h("span", null, h("kbd", { text: "esc" }), " kapat"));
  const box = h("div", { class: "pal", role: "dialog", "aria-modal": "true", "aria-label": "Komut paleti" }, h("div", { class: "pal-in" }, icon("search"), input), list, foot);
  const overlay = h("div", { class: "pal-overlay", hidden: true, onclick: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);

  let items = [];
  let shown = [];
  let idx = 0;
  let restoreFocus = null;

  function score(item, q) {
    if (!q) return 1;
    const hay = trLower(`${item.title} ${item.sub ?? ""} ${item.keywords ?? ""}`);
    const words = q.split(/\s+/).filter(Boolean);
    let s = 0;
    for (const w of words) {
      const i = hay.indexOf(w);
      if (i < 0) return 0;
      s += i === 0 ? 3 : hay[i - 1] === " " ? 2 : 1;
    }
    return s;
  }

  function render() {
    const q = trLower(input.value.trim());
    shown = items.map((it) => ({ it, s: score(it, q) })).filter((x) => x.s > 0).sort((a, b) => (q ? b.s - a.s : 0)).map((x) => x.it).slice(0, 60);
    if (idx >= shown.length) idx = Math.max(0, shown.length - 1);
    list.replaceChildren();
    let group = null;
    shown.forEach((it, i) => {
      if (!q && it.group !== group) {
        group = it.group;
        list.append(h("div", { class: "pal-group", text: group }));
      }
      const el = h("div", { class: `pal-item${i === idx ? " on" : ""}`, role: "option", "aria-selected": String(i === idx), "data-i": String(i) },
        h("span", { class: "pal-ic" }, it.dot ? h("span", { class: `dot ${it.dot}` }) : icon(it.icon ?? "chevronRight")),
        h("span", { class: "pal-title", text: it.title }),
        it.sub ? h("span", { class: "pal-sub", text: it.sub }) : null,
        it.hint ? h("kbd", { text: it.hint }) : null);
      el.addEventListener("mousemove", () => {
        if (idx !== i) {
          idx = i;
          highlight();
        }
      });
      el.addEventListener("click", () => run(i));
      list.append(el);
    });
    if (shown.length === 0) list.append(h("div", { class: "pal-empty", text: "Eşleşen sonuç yok" }));
  }

  function highlight() {
    list.querySelectorAll(".pal-item").forEach((el) => {
      const on = Number(el.getAttribute("data-i")) === idx;
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", String(on));
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  }

  function run(i) {
    const it = shown[i];
    if (!it) return;
    close();
    it.run();
  }

  input.addEventListener("input", () => {
    idx = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      idx = Math.min(shown.length - 1, idx + 1);
      highlight();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  function open() {
    restoreFocus = document.activeElement;
    items = getItems();
    input.value = "";
    idx = 0;
    overlay.hidden = false;
    render();
    input.focus();
  }
  function close() {
    overlay.hidden = true;
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus({ preventScroll: true });
  }

  return {
    open,
    close,
    get isOpen() {
      return !overlay.hidden;
    },
  };
}

/** Build palette items from app state. */
export function paletteItems({ sessions, detail, topics = [], actions }) {
  const out = [];
  for (const t of topics) {
    const c = t.counts;
    out.push({
      group: "Konular",
      title: t.key ? `${t.key}  ${t.title}` : t.title,
      sub: `${t.project} · ${c.running ? `${c.running} çalışıyor` : `${c.total} ajan`} · ${ago(t.lastAt)}`,
      keywords: `konu topic ${t.key ?? ""} ${t.summary} ${t.llmSummary ?? ""} ${t.modules.join(" ")}`,
      dot: c.running ? "running" : "done",
      run: () => actions.openTopic(t.id),
    });
  }
  if (detail) {
    const walk = (n) => {
      out.push({
        group: `Ajanlar · ${detail.name}`,
        title: n.key === "main" ? "Ana ajan" : n.label,
        sub: `${stateLabel(n.state)} · ${n.key === "main" ? "ana" : n.agentType}${n.model ? ` · ${shortModel(n.model)}` : ""}`,
        keywords: `${n.key} ${n.model ?? ""} ${providerInfo(n.provider).label}`,
        dot: n.state,
        run: () => actions.openAgent(n.key),
      });
      n.children.forEach(walk);
    };
    walk(detail.tree);
    // Running first within the group.
    out.sort((a, b) => Number(b.dot === "running") - Number(a.dot === "running"));
  }
  for (const s of sessions) {
    out.push({
      group: "Oturumlar",
      title: s.name,
      sub: `${lastSeg(s.cwd)} · ${s.live ? "canlı" : ago(s.lastActivityAt)} · ${providerInfo(s.provider).short}`,
      // Typing a tool name ("codex", "gemini") filters sessions by tool.
      keywords: `${s.id} ${providerInfo(s.provider).label} ${s.provider}`,
      dot: s.live ? (s.runningAgents > 0 || s.status === "busy" ? "running" : "idle") : "done",
      run: () => actions.selectSession(s.id),
    });
  }
  out.push(
    { group: "Komutlar", title: "Şu an (ana sayfa)", icon: "clock", hint: "g h", keywords: "home ana sayfa çalışan", run: () => actions.goHome() },
    { group: "Komutlar", title: "Zaman çizelgesi", icon: "gantt", hint: "g t", run: () => actions.setView("timeline") },
    { group: "Komutlar", title: "Maliyet", icon: "coins", hint: "g m", run: () => actions.setView("cost") },
    { group: "Komutlar", title: "Ajan araçları (sağlayıcı durumu)", icon: "layers", keywords: "ajanlar providers codex claude sağlayıcı durum", run: () => actions.providers?.() },
    { group: "Komutlar", title: "Temayı değiştir", icon: "moon", keywords: "tema theme dark light koyu açık", run: () => actions.toggleTheme() },
    { group: "Komutlar", title: "Yakınlaştır: son 15 dakika", icon: "clock", run: () => actions.zoom("15m") },
    { group: "Komutlar", title: "Yakınlaştır: son 1 saat", icon: "clock", run: () => actions.zoom("1h") },
    { group: "Komutlar", title: "Yakınlaştır: tüm oturum", icon: "clock", run: () => actions.zoom("all") },
    { group: "Komutlar", title: "Klavye kısayolları", icon: "command", keywords: "help yardım kısayol", hint: "?", run: () => actions.help() },
  );
  return out;
}
