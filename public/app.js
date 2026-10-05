// agent-radar UI shell -- vanilla ES modules, no build. All text goes through textContent.
// Screens: home ("Şu an", no session selected) · session (timeline or cost) · agent detail side panel.

import { $, h, icon, api, fmtTok, fmtUsd, fmtCost, fmtInt, fmtDur, ago, lastSeg, shortModel, fmtTime, findNode, debounce, pathCtx, shortenPaths, providerInfo, providerState } from "./util.js";
import { createTimeline } from "./timeline.js";
import { createHome } from "./home.js";
import { createTopicsList, createTopicView } from "./topics.js";
import { createDetail } from "./detail.js";
import { createCostView } from "./cost.js";
import { createPalette, paletteItems } from "./palette.js";

const DOWN_BANNER_MS = 10_000;

const S = {
  userHome: "",
  sessions: [],
  machine: null,
  providers: [],
  loading: true,
  connected: false,
  everConnected: false,
  downSince: 0,
  failures: 0,
  retryAt: 0,
  resync: false,
  detail: null,
  sel: null,
  view: "timeline",
  openAgent: null,
  detailBusy: false,
  detailAgain: false,
  historyOpen: false,
  headMore: false,
  menuOpen: false,
  homeBusy: false,
  homeAgain: false,
  topic: null,
  topics: null,
  settings: null,
};

// ---- theme ------------------------------------------------------------------------------------------
const storedTheme = () => document.documentElement.getAttribute("data-theme") ?? "system";
function setTheme(t) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem("radar.theme");
    else localStorage.setItem("radar.theme", t);
  } catch {
    /* storage unavailable */
  }
  if (S.menuOpen) renderMenu();
}
function toggleTheme() {
  const dark = storedTheme() === "dark" || (storedTheme() === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
  setTheme(dark ? "light" : "dark");
}

// ---- routing ----------------------------------------------------------------------------------------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { sel: p.get("s") || null, agent: p.get("a") || null, view: p.get("v") === "cost" ? "cost" : "timeline", topic: p.get("t") || null };
}
function saveHash(push = false) {
  const p = new URLSearchParams();
  if (S.sel) p.set("s", S.sel);
  if (S.sel && S.openAgent) p.set("a", S.openAgent);
  if (S.sel && S.view !== "timeline") p.set("v", S.view);
  if (!S.sel && S.topic) p.set("t", S.topic);
  const next = `#${p}`;
  if (next === location.hash || (next === "#" && !location.hash)) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

/** Applies a hash changed from outside (pasted link, back/forward, the brand link). */
function applyHash() {
  const { sel, agent, view, topic } = readHash();
  if (!sel && topic) return openTopic(topic, false);
  if (!sel) return goHome(false);
  if (view !== S.view) setView(view, false);
  if (sel !== S.sel) {
    selectSession(sel, false);
    S.openAgent = agent;
    return;
  }
  if (agent === S.openAgent) return;
  if (agent && S.detail && findNode(S.detail.session.tree, agent)) openAgent(agent);
  else if (agent) S.openAgent = agent;
  else closeAgent(false);
}

const prettyPath = (p) => (p && S.userHome && p.startsWith(S.userHome) ? `~${p.slice(S.userHome.length)}` : p ?? "");

// ---- components -------------------------------------------------------------------------------------
const openAgentIn = (sid, key) => {
  selectSession(sid);
  S.openAgent = key;
  saveHash();
};
const home = createHome($("home-now"), { onOpen: openAgentIn, onSession: (sid) => selectSession(sid) });
const topicsList = createTopicsList($("home-topics"), { onOpen: (id) => openTopic(id) });
const topicView = createTopicView($("topic"), { onBack: () => goHome(), onOpenAgent: openAgentIn, onSession: (sid) => selectSession(sid) });
const timeline = createTimeline($("timeline"), { onOpen: (key) => openAgent(key) });
const detail = createDetail($("detail"), {
  onClose: () => closeAgent(),
  onOpenAgent: (key) => openAgent(key),
  getDetail: () => S.detail?.session ?? null,
});
const cost = createCostView($("cost"), { onOpen: (key) => openAgent(key) });
const palette = createPalette({
  getItems: () =>
    paletteItems({
      sessions: S.sessions,
      detail: S.detail?.session ?? null,
      topics: S.topics?.topics ?? [],
      actions: {
        openTopic: (id) => openTopic(id),
        openAgent,
        selectSession,
        setView,
        goHome,
        toggleTheme,
        providers: () => toggleMenu(true),
        zoom: (z) => {
          setView("timeline");
          timeline.setOptions({ zoom: z });
        },
        help: () => toggleHelp(true),
      },
    }),
});

// ---- top bar ----------------------------------------------------------------------------------------
function renderSummary() {
  const m = S.machine;
  const el = $("summary");
  if (!m) return void (el.textContent = "");
  el.textContent = `${m.runningAgents > 0 ? `${fmtInt(m.runningAgents)} ajan çalışıyor` : "Çalışan ajan yok"} · bugün ~${fmtUsd(m.costToday)}`;
  const by = Object.entries(m.byProvider ?? {}).filter(([, x]) => x.liveSessions || x.finishedToday || x.costToday);
  el.title = [
    `${fmtInt(m.liveSessions)} canlı oturum · bugün ${fmtInt(m.finishedToday)} ajan bitti · ${fmtTok(m.outputToday)} çıktı token`,
    "Maliyet tahminidir (src/pricing.ts); fiyatı bilinmeyen modeller dahil değil.",
    ...by.map(([id, x]) => `${providerInfo(id).label}: ${fmtInt(x.runningAgents)} çalışan · ${fmtUsd(x.costToday)}`),
  ].join("\n");
}

function renderMenu() {
  const menu = $("menu");
  const cur = storedTheme();
  const themeSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Tema" },
    ...[["system", "Sistem"], ["dark", "Koyu"], ["light", "Açık"]].map(([k, t]) =>
      h("button", { class: `seg-btn${cur === k ? " on" : ""}`, role: "radio", "aria-checked": String(cur === k), text: t, onclick: () => setTheme(k) })));
  const rows = S.providers.map((p) => {
    const st = !p.installed ? "kurulu değil" : !p.dataFound ? "veri yok" : p.active > 0 ? `${p.active} aktif` : `${p.sessions} oturum`;
    const tip = [p.home, p.lastActivityAt ? `son etkinlik ${ago(p.lastActivityAt)}` : "", ...(p.notes ?? [])].filter(Boolean).join("\n");
    return h("div", { class: `menu-row${p.installed && p.dataFound ? "" : " off"}`, title: tip },
      h("span", { class: `dot ${p.active > 0 ? "running" : p.dataFound ? "done" : "none"}` }), h("span", { class: "grow", text: p.label }), h("span", { class: "muted num", text: st }));
  });
  menu.replaceChildren(
    h("div", { class: "menu-sec" }, h("div", { class: "menu-h", text: "Tema" }), themeSeg),
    h("div", { class: "menu-sec" }, h("div", { class: "menu-h", text: "Ajan araçları · salt okunur" }), ...(rows.length ? rows : [h("div", { class: "muted", text: "Kayıtlı araç yok." })])),
    h("div", { class: "menu-sec" }, h("div", { class: "menu-h", text: "Konu özetleri" }), ...summarizerRows()),
    h("button", { class: "menu-link", onclick: () => (toggleMenu(false), toggleHelp(true)) }, h("span", { text: "Klavye kısayolları" }), h("kbd", { text: "?" })));
}

function summarizerRows() {
  const z = S.settings?.summarizer;
  if (!z) return [h("div", { class: "muted", text: "Durum yükleniyor…" })];
  if (!z.enabled) {
    return [
      h("div", { class: "menu-row" }, h("span", { class: "dot none" }), h("span", { class: "grow", text: "Model özeti: kapalı" })),
      h("div", { class: "menu-hint muted", text: z.reason && !/ile açılır/.test(z.reason) ? z.reason : "Açmak için sunucuyu AGENT_RADAR_SUMMARIZER=codex ile başlatın. Varsayılan kapalıdır; konu satırları model olmadan, yalnızca yerel verilerle özetlenir." }),
    ];
  }
  return [
    h("div", { class: "menu-row" }, h("span", { class: "dot running" }), h("span", { class: "grow", text: `Model özeti: açık (${z.model})` }), h("span", { class: "muted num", text: `${z.callsLastHour}/${z.maxPerHour} sa` })),
    h("div", { class: "menu-hint muted", text: z.disclosure }),
    z.lastError ? h("div", { class: "menu-hint bad", text: `Son hata: ${z.lastError}` }) : null,
  ];
}

async function loadSettings() {
  try {
    S.settings = await api("/api/settings");
  } catch {
    S.settings = null;
  }
  if (S.menuOpen) renderMenu();
}

function toggleMenu(force) {
  S.menuOpen = force ?? !S.menuOpen;
  $("menu").hidden = !S.menuOpen;
  $("menu-btn").setAttribute("aria-expanded", String(S.menuOpen));
  if (S.menuOpen) {
    renderMenu();
    void loadSettings();
  }
}

function renderConn() {
  const el = $("conn");
  const down = !S.connected && (S.everConnected || S.failures > 0);
  el.className = `conn ${S.connected ? "on" : down ? "retry" : "wait"}`;
  const secs = Math.max(1, Math.round((S.retryAt - Date.now()) / 1000));
  el.title = S.connected ? "Canlı bağlı" : down ? `Bağlantı yok · sonraki deneme ${secs} sn içinde (tıklayın: şimdi dene)` : "Bağlanıyor…";
  const banner = $("conn-banner");
  const showBanner = down && S.downSince > 0 && Date.now() - S.downSince > DOWN_BANNER_MS;
  banner.hidden = !showBanner;
  if (showBanner) {
    banner.replaceChildren(
      h("span", { text: S.everConnected ? "Sunucu bağlantısı koptu; son bilinen durum gösteriliyor." : "Sunucuya ulaşılamıyor." }),
      h("span", { class: "muted num", text: `Yeniden deneme ${secs} sn içinde` }),
      h("button", { class: "link", text: "Şimdi dene", onclick: reconnectNow }));
  }
}

// ---- session rail -----------------------------------------------------------------------------------
function renderRail() {
  const rail = $("rail");
  if (S.loading && S.sessions.length === 0) {
    rail.replaceChildren(h("div", { class: "rail-h", text: "Canlı" }), ...Array.from({ length: 4 }, () => h("div", { class: "sk-row" }, h("i"), h("b", { class: "w2" }))));
    return;
  }
  if (!S.everConnected && S.sessions.length === 0) {
    rail.replaceChildren(h("div", { class: "rail-none muted", text: "Sunucuya bağlanılamıyor." }));
    return;
  }
  // Live sessions in a stable order (newest start first) so the list does not reshuffle on every event.
  const started = (s) => s.startedAt ?? s.firstActivityAt ?? 0;
  const live = S.sessions.filter((s) => s.live).sort((a, b) => started(b) - started(a) || a.id.localeCompare(b.id));
  const past = S.sessions.filter((s) => !s.live);
  const liveList = h("div", { class: "rail-list" }, ...live.map(railItem));
  if (live.length === 0) liveList.append(h("div", { class: "rail-none muted", text: "Canlı oturum yok." }));
  const pastSec = h("details", { class: "rail-past", open: S.historyOpen || past.some((s) => s.id === S.sel) });
  pastSec.addEventListener("toggle", () => (S.historyOpen = pastSec.open));
  pastSec.append(h("summary", { class: "rail-h" }, icon("chevronRight", "chev"), h("span", { text: "Geçmiş" }), h("span", { class: "rail-n num", text: String(past.length) })), h("div", { class: "rail-list" }, ...past.map(railItem)));
  const keepTop = rail.scrollTop;
  rail.replaceChildren(h("div", { class: "rail-h" }, h("span", { text: "Canlı" }), h("span", { class: "rail-n num", text: String(live.length) })), liveList, ...(past.length ? [pastSec] : []));
  rail.scrollTop = keepTop;
}

function railItem(s) {
  const sel = s.id === S.sel;
  const state = s.live ? (s.runningAgents > 0 || s.status === "busy" ? "running" : "idle") : "done";
  return h("button", { class: `ri${sel ? " sel" : ""}`, title: `${s.name}\n${prettyPath(s.cwd)}`, "aria-current": sel ? "true" : null, onclick: () => selectSession(s.id) },
    h("span", { class: `dot ${state}` }),
    h("span", { class: "ri-t", text: s.name }),
    s.runningAgents > 0 ? h("span", { class: "ri-n num", title: `${s.runningAgents} çalışan ajan`, text: String(s.runningAgents) }) : null,
    h("span", { class: "ri-s" }, h("span", { text: `${lastSeg(s.cwd) || "?"} · ${ago(s.lastActivityAt)}` }), h("span", { class: "ri-pv", text: providerInfo(s.provider).short })));
}

// ---- session header ---------------------------------------------------------------------------------
function renderHead() {
  const el = $("sess-head");
  const x = S.detail?.session ?? S.sessions.find((s) => s.id === S.sel);
  if (!x) {
    el.replaceChildren(h("h1", { class: "sh-title muted", text: S.loading ? "Yükleniyor…" : "Oturum bulunamadı" }));
    return;
  }
  const busy = x.live && (x.status === "busy" || x.runningAgents > 0);
  const caps = providerInfo(x.provider).caps;
  const num = (v, label, extra = {}) => h(extra.onclick ? "button" : "span", { class: `sh-num${extra.cls ? ` ${extra.cls}` : ""}`, ...extra }, h("b", { class: "num", text: v }), h("span", { text: label }));
  const numbers = h("div", { class: "sh-nums" },
    x.runningAgents ? num(fmtInt(x.runningAgents), "çalışan", { cls: "hot" }) : null,
    num(fmtInt(x.agentCount), "ajan"),
    caps.tokens ? num(fmtCost(x), "", { cls: "link-num", title: x.costPartial ? "Bazı modellerin fiyatı bilinmiyor · maliyet ayrıntısı" : "Tahmini maliyet · ayrıntı", onclick: () => setView(S.view === "cost" ? "timeline" : "cost") }) : null);
  const tabs = h("div", { class: "tabs", role: "tablist" },
    ...[["timeline", "Zaman çizelgesi"], ["cost", "Maliyet"]].map(([k, t]) =>
      caps.tokens || k === "timeline" ? h("button", { class: `tab${S.view === k ? " on" : ""}`, role: "tab", "aria-selected": String(S.view === k), text: t, onclick: () => setView(k) }) : null));
  const started = x.startedAt ?? x.firstActivityAt;
  const facts = [
    ["Araç", providerInfo(x.provider).label],
    ["Klasör", prettyPath(x.cwd)],
    x.gitBranch ? ["Dal", x.gitBranch] : null,
    x.model ? ["Model", shortModel(x.model)] : null,
    started ? ["Başladı", `${fmtTime(started)} · ${fmtDur((x.live ? Date.now() : x.lastActivityAt) - started)}`] : null,
    x.version ? ["Sürüm", `v${x.version}`] : null,
    x.provider !== "claude-code" && x.entrypoint ? ["Giriş", x.entrypoint] : null,
    x.lastPrompt ? ["Son istem", shortenPaths(x.lastPrompt, pathCtx)] : null,
  ].filter(Boolean);
  const more = h("details", { class: "disclosure", open: S.headMore }, h("summary", { text: "Ayrıntılar" }),
    h("dl", { class: "sh-more" }, ...facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v, title: v })])));
  more.addEventListener("toggle", () => (S.headMore = more.open));
  el.replaceChildren(
    h("div", { class: "sh-row" },
      h("h1", { class: "sh-title", text: x.name, title: x.name }),
      h("span", { class: `sh-state ${busy ? "running" : x.live ? "idle" : "done"}` }, h("span", { class: `dot ${busy ? "running" : x.live ? "idle" : "done"}` }), h("span", { text: x.live ? (busy ? "Canlı · çalışıyor" : "Canlı · boşta") : `Bitti · ${ago(x.lastActivityAt)}` })),
      h("div", { class: "grow" }), numbers),
    h("div", { class: "sh-row sub" }, h("span", { class: "muted sh-folder", title: prettyPath(x.cwd), text: lastSeg(x.cwd) || prettyPath(x.cwd) }), more, h("div", { class: "grow" }), tabs));
}

// ---- views ------------------------------------------------------------------------------------------
function setView(v, save = true) {
  S.view = v;
  $("timeline").hidden = v !== "timeline";
  $("cost").hidden = v !== "cost";
  if (v === "cost") cost.render(S.detail?.session ?? null);
  if (save) saveHash();
  if (S.sel) renderHead();
}

function showScreen() {
  $("home").hidden = Boolean(S.sel) || Boolean(S.topic);
  $("topic").hidden = Boolean(S.sel) || !S.topic;
  $("session").hidden = !S.sel;
}

// ---- selection + data flow ----------------------------------------------------------------------------
function openTopic(id, save = true) {
  if (S.openAgent) closeAgent(false);
  S.sel = null;
  S.detail = null;
  S.topic = id;
  pathCtx.cwd = "";
  showScreen();
  if (save) saveHash(true);
  renderRail();
  topicView.set(S.topics, id);
  void refreshHome();
}

function goHome(save = true) {
  if (S.openAgent) closeAgent(false);
  S.topic = null;
  S.sel = null;
  S.detail = null;
  pathCtx.cwd = "";
  showScreen();
  if (save) saveHash(true);
  renderRail();
  void refreshHome();
}

function selectSession(id, save = true) {
  if (S.sel === id) return;
  S.topic = null;
  S.sel = id;
  S.detail = null;
  pathCtx.cwd = S.sessions.find((s) => s.id === id)?.cwd ?? "";
  if (S.openAgent) closeAgent(false);
  showScreen();
  if (save) saveHash(true);
  renderRail();
  renderHead();
  timeline.loading();
  void refreshDetail();
}

function openAgent(key) {
  if (!S.sel) return;
  S.openAgent = key;
  timeline.setCursor(key);
  timeline.setOpen(key);
  $("session").classList.add("with-detail");
  detail.open(S.sel, key);
  saveHash();
}

function closeAgent(save = true) {
  S.openAgent = null;
  timeline.setOpen(null);
  $("session").classList.remove("with-detail");
  detail.close();
  if (save) saveHash();
}

async function refreshDetail() {
  if (!S.sel) return;
  if (S.detailBusy) return void (S.detailAgain = true);
  S.detailBusy = true;
  const sid = S.sel;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(sid)}`);
    if (sid !== S.sel) return;
    S.detail = r;
    pathCtx.cwd = r.session.cwd ?? "";
    timeline.update(r.session, Date.now());
    renderHead();
    if (S.view === "cost") cost.render(r.session);
    if (S.openAgent) {
      if (!findNode(r.session.tree, S.openAgent)) closeAgent();
      else if (!detail.isOpen) openAgent(S.openAgent);
      else detail.refresh();
    }
  } catch (err) {
    if (sid !== S.sel) return;
    // A dropped connection keeps the last good view; the reconnect resyncs it.
    if (S.detail && err?.status !== 404) return;
    timeline.error(err?.status === 404 ? "Oturum bulunamadı; artık diskte olmayabilir." : "Oturum yüklenemedi; sunucuya ulaşılamıyor.");
  } finally {
    S.detailBusy = false;
    if (S.detailAgain) {
      S.detailAgain = false;
      void refreshDetail();
    }
  }
}

async function refreshHome() {
  if (S.sel) return;
  if (S.homeBusy) return void (S.homeAgain = true);
  S.homeBusy = true;
  try {
    const [r, tp] = await Promise.all([api("/api/now"), api("/api/topics?window=24h").catch(() => null)]);
    if (tp) S.topics = tp;
    if (!S.sel) {
      home.set(r);
      if (S.topics) topicsList.set(S.topics);
      if (S.topic) topicView.set(S.topics, S.topic);
    }
  } catch {
    /* keep the last good list; the reconnect resyncs it */
  } finally {
    S.homeBusy = false;
    if (S.homeAgain) {
      S.homeAgain = false;
      void refreshHome();
    }
  }
}

function onUpdate(data) {
  S.sessions = data.sessions ?? [];
  S.machine = data.machine ?? null;
  S.loading = Boolean(data.loading);
  if (Array.isArray(data.providers)) {
    S.providers = data.providers;
    providerState.list = data.providers;
    if (S.menuOpen) renderMenu();
  }
  renderSummary();
  renderRail();
  const changed = data.changed ?? [];
  const resync = S.resync;
  S.resync = false;
  if (!S.sel) return void refreshHome();
  if (!S.detail) renderHead();
  if (resync || (changed.length === 0 ? !S.detail : changed.includes(S.sel))) void refreshDetail();
}

// ---- live stream: own reconnect loop with exponential backoff ------------------------------------------
// EventSource's built-in retry hammers a dead server every couple of seconds (one console error each);
// instead the stream is closed on the first error and reopened after 1s, 2s, 4s … 30s (with jitter).
let es = null;
let retryTimer = null;
const RETRY_MIN = 1000;
const RETRY_MAX = 30_000;

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (es) es.close();
  const src = new EventSource("/api/stream");
  es = src;
  src.addEventListener("open", () => {
    if (es !== src) return;
    if (S.everConnected && !S.connected) S.resync = true; // missed updates while we were away
    S.connected = true;
    S.everConnected = true;
    S.failures = 0;
    S.downSince = 0;
    renderConn();
  });
  src.addEventListener("error", () => {
    if (es !== src) return;
    src.close();
    es = null;
    const wasUp = S.connected;
    S.connected = false;
    if (!S.downSince) S.downSince = Date.now();
    S.failures++;
    scheduleRetry();
    renderConn();
    if (wasUp || S.failures === 1) renderRail();
  });
  src.addEventListener("update", (ev) => {
    if (es !== src) return;
    try {
      onUpdate(JSON.parse(ev.data));
    } catch (err) {
      console.error("agent-radar: update failed", err);
    }
  });
}

function scheduleRetry() {
  if (retryTimer) return;
  const base = Math.min(RETRY_MAX, RETRY_MIN * 2 ** Math.max(0, S.failures - 1));
  const delay = Math.round(base * (0.85 + Math.random() * 0.3));
  S.retryAt = Date.now() + delay;
  retryTimer = setTimeout(connect, delay);
}

/** Skip the rest of the backoff (tab became visible, network came back, indicator clicked). */
function reconnectNow() {
  if (S.connected || es) return;
  connect();
}

// ---- keyboard ---------------------------------------------------------------------------------------
let gPending = false;
function onKey(e) {
  const typing = e.target instanceof HTMLElement && (e.target.matches("input, textarea, select") || e.target.isContentEditable);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (palette.isOpen) palette.close();
    else palette.open();
    return;
  }
  if (palette.isOpen) return;
  if (e.key === "Escape") {
    if (!$("help").hidden) return toggleHelp(false);
    if (S.menuOpen) return toggleMenu(false);
    if (detail.isOpen) return closeAgent();
    if (typing) return e.target.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (gPending) {
    gPending = false;
    if (e.key === "t") return setView("timeline");
    if (e.key === "m") return setView("cost");
    if (e.key === "h") return goHome();
  }
  switch (e.key) {
    case "/":
      e.preventDefault();
      palette.open();
      break;
    case "j":
    case "k":
    case "ArrowDown":
    case "ArrowUp": {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement?.closest?.(".feed, .rail, .cost")) return;
      if (!S.sel && S.topic) return;
      const list = S.sel ? (S.view === "timeline" ? timeline : null) : home;
      if (!list) return;
      e.preventDefault();
      const keys = list.keys();
      if (keys.length === 0) return;
      const cur = keys.indexOf(list.cursor);
      const down = e.key === "j" || e.key === "ArrowDown";
      const next = keys[cur < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, cur + (down ? 1 : -1)))];
      list.setCursor(next);
      if (S.sel && detail.isOpen) openAgent(next);
      break;
    }
    case "Enter":
      if (e.target.closest?.("button, a, summary")) return;
      if (!S.sel) {
        if (home.openCursor()) e.preventDefault();
      } else if (timeline.cursor) {
        e.preventDefault();
        openAgent(timeline.cursor);
      }
      break;
    case "g":
      gPending = true;
      setTimeout(() => (gPending = false), 800);
      break;
    case "1":
    case "2":
    case "3":
      if (S.sel) timeline.setOptions({ zoom: { 1: "15m", 2: "1h", 3: "all" }[e.key] });
      break;
    case "?":
      toggleHelp();
      break;
    default:
  }
}

function toggleHelp(force) {
  const el = $("help");
  const show = force ?? el.hidden;
  el.hidden = !show;
  if (!show || el.childElementCount) return;
  const row = (keys, text) => h("div", { class: "help-row" }, h("span", { class: "help-keys" }, ...keys.map((k) => h("kbd", { text: k }))), h("span", { text }));
  el.append(h("div", { class: "help-box", role: "dialog", "aria-label": "Klavye kısayolları" },
    h("div", { class: "help-h" }, h("h2", { text: "Klavye kısayolları" }), h("button", { class: "icon-btn", "aria-label": "Kapat", onclick: () => toggleHelp(false) }, icon("x"))),
    row(["⌘", "K"], "Ara / komut"),
    row(["/"], "Ara / komut"),
    row(["j", "k"], "Sonraki / önceki ajan"),
    row(["↵"], "Ajanı aç"),
    row(["esc"], "Kapat"),
    row(["1", "2", "3"], "Son 15 dk · 1 sa · tümü"),
    row(["g", "h"], "Şu an"),
    row(["g", "t"], "Zaman çizelgesi"),
    row(["g", "m"], "Maliyet")));
  el.addEventListener("click", (ev) => {
    if (ev.target === el) toggleHelp(false);
  });
}

// ---- ticker -----------------------------------------------------------------------------------------
function tick() {
  if (document.hidden) return;
  const now = Date.now();
  if (!S.connected && S.failures > 0) renderConn();
  if (S.sel) {
    timeline.tick(now);
    detail.tick(now);
  } else home.tick(now);
}

// ---- init -------------------------------------------------------------------------------------------
async function init() {
  const hs = readHash();
  S.sel = hs.sel;
  S.topic = hs.sel ? null : hs.topic;
  S.openAgent = hs.sel ? hs.agent : null;
  S.view = hs.view;
  renderConn();
  showScreen();
  $("timeline").hidden = S.view !== "timeline";
  $("cost").hidden = S.view !== "cost";
  $("conn").addEventListener("click", reconnectNow);
  window.addEventListener("online", reconnectNow);
  window.addEventListener("pagehide", () => es?.close());
  window.addEventListener("hashchange", applyHash);
  window.addEventListener("popstate", applyHash);
  $("pal-btn").addEventListener("click", () => palette.open());
  $("pal-btn").querySelector("kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  $("menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (e) => {
    if (S.menuOpen && !(e.target instanceof Node && $("menu").contains(e.target))) toggleMenu(false);
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    tick();
    reconnectNow();
  });
  renderRail();
  if (S.sel) {
    renderHead();
    timeline.loading();
    // Capabilities decide what the detail panel shows; know them before the first detail render.
    try {
      const pr = await api("/api/providers");
      if (Array.isArray(pr.providers)) {
        S.providers = pr.providers;
        providerState.list = pr.providers;
      }
    } catch {
      /* the SSE update brings them */
    }
    void refreshDetail();
  } else {
    home.set(null);
    topicsList.set(null);
    if (S.topic) topicView.set(null, S.topic);
    void refreshHome();
  }
  try {
    const [health, pricing] = await Promise.all([api("/api/health"), api("/api/pricing").catch(() => null)]);
    S.userHome = health.userHome ?? "";
    pathCtx.home = S.userHome;
    if (pricing) cost.setPricing(pricing);
    renderRail();
    if (S.sel) renderHead();
  } catch {
    /* non-fatal */
  }
  connect();
  setInterval(tick, 1000);
  window.addEventListener("resize", debounce(() => S.sel && renderHead(), 150));
}

init();
