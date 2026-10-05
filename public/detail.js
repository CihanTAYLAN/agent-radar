// Agent detail side panel: name, state and three facts; everything else under "Ayrıntılar"; then the
// conversation stream. Events are fetched newest-first in small pages (tail + `before` cursor, older
// pages load on scroll-up) and appended incrementally (`after` cursor).

import { h, icon, api, ACTION, toolKind, toolLabel, stateLabel, fmtDur, fmtTok, fmtCost, fmtInt, fmtIsoTime, fmtTime, shortModel, findNode, nodeEnd, humanizeCommand, shortenPaths, pathCtx, providerInfo } from "./util.js";
import { renderMarkdown } from "./markdown.js";
import { lineDiff, parsePatch } from "./diff.js";

/** First page: enough to fill the panel; older pages are larger (the user is scrolling back). */
const FIRST_PAGE = 50;
const OLDER_PAGE = 100;

export function createDetail(root, { onClose, onOpenAgent, getDetail }) {
  const S = {
    sid: null,
    key: null,
    cursor: null,
    start: 0,
    truncated: false,
    fetching: false,
    again: false,
    olderBusy: false,
    follow: true,
    autoScrolling: false,
    fresh: 0,
    textOnly: loadTextOnly(),
    cards: new Map(), // toolUseId -> card refs
    spawnLinks: [], // { toolUseId, slot }
    firstUserSeen: false,
    gen: 0,
  };

  // ---- DOM -------------------------------------------------------------------------------------------
  const stateEl = h("span", { class: "dt-state" });
  const title = h("h2", { class: "dt-title" });
  const facts = h("div", { class: "dt-facts num" });
  const more = h("dl", { class: "dt-more" });
  const moreBox = h("details", { class: "disclosure" }, h("summary", { text: "Ayrıntılar" }), more);
  const reason = h("div", { class: "dt-reason", hidden: true });
  const textBtn = h("button", { class: "btn quiet toggle", "aria-pressed": String(S.textOnly), title: "Araç çağrılarını ve düşünceleri gizle", onclick: () => setTextOnly(!S.textOnly) }, h("span", { class: "sw", "aria-hidden": "true" }), h("span", { text: "Sadece metin" }));
  const head = h("header", { class: "dt-head" },
    h("div", { class: "dt-row" }, stateEl, h("div", { class: "grow" }), h("button", { class: "icon-btn", title: "Kapat (Esc)", "aria-label": "Kapat", onclick: () => onClose() }, icon("x"))),
    title, facts, reason,
    h("div", { class: "dt-row" }, moreBox, h("div", { class: "grow" }), textBtn));

  const list = h("div", { class: "feed-list" });
  const older = h("div", { class: "feed-older muted", hidden: true });
  const feedState = h("div", { class: "feed-state", hidden: true });
  const feed = h("div", { class: "feed", tabIndex: 0 }, older, list, feedState);
  const jump = h("button", { class: "jump", hidden: true, onclick: () => setFollow(true) }, icon("arrowDown"), h("span", { class: "jump-t", text: "En sona git" }));
  root.append(head, h("div", { class: "feed-wrap" }, feed, jump));
  feed.classList.toggle("text-only", S.textOnly);

  feed.addEventListener("scroll", () => {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
    if (atBottom) {
      S.fresh = 0;
      jump.hidden = true;
      S.follow = true;
    } else if (!S.autoScrolling) S.follow = false;
    if (feed.scrollTop < 240 && S.truncated && !S.olderBusy && list.childElementCount > 0) void loadOlder();
  });

  function loadTextOnly() {
    try {
      return localStorage.getItem("radar.textOnly") === "1";
    } catch {
      return false;
    }
  }
  function setTextOnly(on) {
    S.textOnly = on;
    textBtn.setAttribute("aria-pressed", String(on));
    feed.classList.toggle("text-only", on);
    try {
      localStorage.setItem("radar.textOnly", on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    if (S.follow) scrollBottom();
  }
  function setFollow(on) {
    S.follow = on;
    if (!on) return;
    S.fresh = 0;
    jump.hidden = true;
    scrollBottom();
  }
  function scrollBottom() {
    S.autoScrolling = true;
    feed.scrollTop = feed.scrollHeight;
    requestAnimationFrame(() => {
      feed.scrollTop = feed.scrollHeight;
      S.autoScrolling = false;
    });
  }

  // ---- header ----------------------------------------------------------------------------------------
  function renderHead() {
    const d = getDetail();
    const n = d ? findNode(d.tree, S.key) : null;
    if (!n) return;
    const isMain = n.key === "main";
    const caps = providerInfo(d.provider).caps;
    title.textContent = isMain ? "Ana ajan" : n.label;
    title.title = isMain ? d.name : n.label;
    stateEl.className = `dt-state ${n.state}`;
    stateEl.replaceChildren(h("span", { class: `dot ${n.state}` }), h("span", { text: stateLabel(n.state) }));

    const dur = n.startedAt ? nodeEnd(n, Date.now()) - n.startedAt : 0;
    const f = [h("span", { "data-since": n.state === "running" && n.startedAt ? String(n.startedAt) : null, text: fmtDur(dur) })];
    if (caps.tools) f.push(h("span", { text: `${fmtInt(n.toolCalls)} araç çağrısı` }));
    if (caps.tokens) f.push(h("span", { title: n.costPartial ? "Bazı modellerin fiyatı bilinmiyor" : "Tahmini maliyet", text: fmtCost(n) }));
    facts.replaceChildren(...f.flatMap((x, i) => (i ? [h("span", { class: "sep", text: "·" }), x] : [x])));

    const parent = n.parentKey ? findNode(d.tree, n.parentKey) : null;
    const u = n.usage;
    const rows = [
      ["Oturum", d.name],
      parent ? ["Üst ajan", h("button", { class: "link", text: parent.key === "main" ? "Ana ajan" : parent.label, onclick: () => onOpenAgent(parent.key) })] : null,
      ["Tür", isMain ? "ana ajan" : n.agentType],
      n.model ? ["Model", shortModel(n.model)] : null,
      ["Araç", providerInfo(d.provider).label],
      n.mode === "background" ? ["Mod", "arka plan"] : n.mode === "foreground" ? ["Mod", "ön plan"] : null,
      n.startedAt ? ["Başladı", fmtTime(n.startedAt)] : null,
      n.worktreeBranch ? ["Dal", n.worktreeBranch] : null,
      caps.tokens ? ["Çıktı token", fmtTok(u.output)] : null,
      caps.tokens ? ["Giriş · önbellek", `${fmtTok(u.input)} · ${fmtTok(u.cacheRead)} okuma · ${fmtTok(u.cacheCreate)} yazma`] : null,
      ...(n.meta ? Object.entries(n.meta).map(([k, v]) => [k, String(v)]) : []),
    ].filter(Boolean);
    more.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", null, v)]));

    const showReason = n.endReason && (n.state === "failed" || n.state === "stopped");
    reason.hidden = !showReason;
    if (showReason) {
      reason.className = `dt-reason ${n.state}`;
      reason.textContent = n.endReason;
    }
  }

  // ---- events ----------------------------------------------------------------------------------------
  const url = (q) => `/api/sessions/${encodeURIComponent(S.sid)}/agents/${encodeURIComponent(S.key)}/events?${q}`;

  async function loadInitial() {
    const gen = ++S.gen;
    const d0 = getDetail();
    if (d0 && !providerInfo(d0.provider).caps.transcript) {
      reset();
      showState("Bu ajan transkript sağlamıyor; yalnızca özet bilgiler gösteriliyor.");
      return;
    }
    S.fetching = true;
    showSkeleton();
    try {
      const r = await api(url(`tail=${FIRST_PAGE}`));
      if (gen !== S.gen) return;
      reset();
      S.cursor = r.cursor;
      S.start = r.start;
      S.truncated = r.truncated;
      feedState.hidden = true;
      appendEvents(r.events, false);
      updateOlder();
      if (r.events.length === 0) showState("Henüz olay yok.");
      setFollow(true);
    } catch (err) {
      if (gen !== S.gen) return;
      if (!err?.status) console.error("agent-radar: rendering agent events failed", err);
      showState("Olaylar yüklenemedi. Ajan dosyası henüz oluşmamış olabilir.");
    } finally {
      if (gen === S.gen) S.fetching = false;
      if (S.again) {
        S.again = false;
        void poll();
      }
    }
  }

  function showSkeleton() {
    list.replaceChildren();
    feedState.hidden = false;
    feedState.replaceChildren(...Array.from({ length: 6 }, (_, i) => h("div", { class: "sk-row" }, h("i"), h("b", { class: `w${i % 4}` }))));
  }
  function showState(text) {
    feedState.hidden = false;
    feedState.replaceChildren(h("div", { class: "feed-empty muted", text }));
  }
  function updateOlder() {
    older.hidden = !S.truncated;
    older.textContent = S.olderBusy ? "Daha eski olaylar yükleniyor…" : "Daha eskiler için yukarı kaydırın";
  }

  async function poll() {
    if (!S.key || S.cursor === null) return;
    if (S.fetching) {
      S.again = true;
      return;
    }
    const gen = S.gen;
    S.fetching = true;
    try {
      const r = await api(url(`after=${S.cursor}`));
      if (gen !== S.gen) return;
      if (r.reset) {
        S.fetching = false;
        return void loadInitial();
      }
      S.cursor = r.cursor;
      if (r.events.length > 0) {
        feedState.hidden = true;
        appendEvents(r.events, true);
      }
    } catch {
      /* transient; next update retries */
    } finally {
      if (gen === S.gen) S.fetching = false;
      if (S.again) {
        S.again = false;
        void poll();
      }
    }
  }

  async function loadOlder() {
    if (S.olderBusy || !S.truncated) return;
    S.olderBusy = true;
    updateOlder();
    const gen = S.gen;
    try {
      const r = await api(url(`tail=${OLDER_PAGE}&before=${S.start}`));
      if (gen !== S.gen) return;
      const prevH = feed.scrollHeight;
      const prevTop = feed.scrollTop;
      const tmp = h("div");
      for (const ev of r.events) renderEvent(ev, tmp);
      list.prepend(...tmp.childNodes);
      S.start = r.start;
      S.truncated = r.truncated;
      feed.scrollTop = prevTop + (feed.scrollHeight - prevH);
    } catch {
      /* ignore; the next scroll retries */
    } finally {
      S.olderBusy = false;
      if (gen === S.gen) updateOlder();
    }
  }

  function reset() {
    list.replaceChildren();
    S.cards.clear();
    S.spawnLinks = [];
    S.firstUserSeen = false;
    S.fresh = 0;
    jump.hidden = true;
  }

  function appendEvents(evs, live) {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
    const tmp = h("div");
    let added = 0;
    for (const ev of evs) added += renderEvent(ev, tmp);
    list.append(...tmp.childNodes);
    if (S.follow && (atBottom || !live)) scrollBottom();
    else if (live && added > 0) {
      S.fresh += added;
      jump.hidden = false;
      jump.querySelector(".jump-t").textContent = `${S.fresh} yeni olay`;
    }
  }

  /** Render one event into `into` (or into its tool card). Returns 1 if a new visible item was added. */
  function renderEvent(ev, into) {
    switch (ev.kind) {
      case "tool_use":
        into.append(toolCard(ev));
        return 1;
      case "tool_result": {
        const card = ev.toolUseId ? S.cards.get(ev.toolUseId) : null;
        if (card) {
          attachResult(card, ev);
          return 0;
        }
        into.append(h("div", { class: "ev ev-tool" }, gutter(ev), resultBlock(ev)));
        return 1;
      }
      case "assistant":
        into.append(h("div", { class: "ev ev-text" }, gutter(ev), renderMarkdown(ev.text)));
        return 1;
      case "user": {
        const isPrompt = !S.firstUserSeen && S.key !== "main";
        S.firstUserSeen = true;
        into.append(h("div", { class: "ev ev-text ev-user" }, gutter(ev), h("div", { class: "ev-main" },
          h("div", { class: "who", text: isPrompt ? "Görev istemi" : "Kullanıcı" }), collapsible(renderMarkdown(ev.text), ev.text.length > 600))));
        return 1;
      }
      case "thinking":
        into.append(h("div", { class: "ev ev-thinking" }, gutter(ev), collapsible(h("div", { class: "thinking-text", text: ev.text }), true, "Düşünce")));
        return 1;
      case "notification":
        into.append(h("div", { class: "ev ev-note" }, gutter(ev), h("span", { class: "muted", text: notificationText(ev.text) })));
        return 1;
      default:
        return 0;
    }
  }

  function notificationText(t) {
    return shortenPaths(t, pathCtx)
      .replace(/^task (\S+) completed/, "Görev $1 tamamlandı")
      .replace(/^task (\S+) failed/, "Görev $1 başarısız")
      .replace(/^task (\S+) (killed|stopped)/, "Görev $1 durduruldu")
      .replace(/^task (\S+) update/, "Görev $1 güncellemesi");
  }

  const gutter = (ev) => h("div", { class: "ev-time num", text: fmtIsoTime(ev.ts) });

  function collapsible(content, collapsed, label = "Devamını göster") {
    if (!collapsed) return content;
    const wrap = h("div", { class: "collapsible folded" }, content);
    const btn = h("button", { class: "more", text: label, onclick: () => {
      const folded = wrap.classList.toggle("folded");
      btn.textContent = folded ? label : "Daralt";
    } });
    return h("div", null, wrap, btn);
  }

  function toolCard(ev) {
    const kind = ev.action ?? toolKind(ev.tool);
    const a = ACTION[kind] ?? ACTION.other;
    const d = ev.detail ?? {};
    const status = h("span", { class: "tc-status" });
    const node = findNode(getDetail()?.tree, S.key);
    if (node && (node.state === "running" || node.state === "idle")) status.append(h("span", { class: "spin", title: "Sonuç bekleniyor" }));
    const target = headline(ev, kind, d);
    const stat = kind === "edit" && d.patch !== undefined ? parsePatch(d.patch) : kind === "edit" && (d.old_string !== undefined || d.new_string !== undefined) ? lineDiff(d.old_string ?? "", d.new_string ?? "") : null;
    const head = h("div", { class: "tc-head" },
      icon(a.icon, "tc-ic"),
      h("span", { class: "tc-tool", text: toolLabel(ev.tool) }),
      target ? h("span", { class: "tc-target", title: target, text: target }) : null,
      h("span", { class: "grow" }),
      stat ? h("span", { class: "diff-stat num", title: `${stat.add} satır eklendi, ${stat.del} satır silindi` }, h("span", { class: "ds-add", text: `+${stat.add}` }), h("span", { class: "ds-del", text: `−${stat.del}` })) : null,
      status);
    const resultSlot = h("div", { class: "tc-result", hidden: true });
    const card = h("div", { class: "tool-card" }, head, toolBody(ev, kind, d), resultSlot);
    if (ev.toolUseId) S.cards.set(ev.toolUseId, { card, status, resultSlot });
    return h("div", { class: "ev ev-tool" }, gutter(ev), card);
  }

  function headline(ev, kind, d) {
    switch (kind) {
      case "bash":
        return d.description ?? "";
      case "edit":
      case "write":
      case "read":
        if (d.patch !== undefined && Number(d.files) > 1) return ev.text;
        return shortenPaths(d.file_path ?? d.notebook_path ?? ev.text, pathCtx);
      case "search":
        return d.pattern ? `${d.pattern}${d.path ? ` · ${shortenPaths(d.path, pathCtx)}` : ""}${d.glob ? ` · ${d.glob}` : ""}` : ev.text;
      case "agent":
        return d.description ?? ev.text;
      default:
        return oneLineHuman(ev.text);
    }
  }

  function toolBody(ev, kind, d) {
    if (kind === "bash" && (d.command ?? ev.text) && !(d.code && !d.command)) return commandBlock(d.command ?? ev.text);
    if (kind === "edit" && d.patch !== undefined) return patchView(d.patch);
    if (d.code) return collapsible(h("pre", { class: "code-block" }, h("code", { text: d.code })), d.code.split("\n").length > 8, "Kodu göster");
    if (kind === "edit" && (d.old_string !== undefined || d.new_string !== undefined)) {
      const wrap = diffView(d.old_string ?? "", d.new_string ?? "");
      if (d.edits && Number(d.edits) > 1) wrap.append(h("div", { class: "dl gap" }, h("span", { class: "dm" }), h("span", { class: "dt", text: `+${Number(d.edits) - 1} düzenleme daha` })));
      return wrap;
    }
    if (kind === "write" && d.content) return collapsible(h("pre", { class: "code-block" }, h("code", { text: d.content })), true, "İçeriği göster");
    if (kind === "agent") {
      const slot = h("span", { class: "spawn-link" });
      const box = h("div", { class: "spawn" }, slot, d.prompt ? collapsible(renderMarkdown(d.prompt), true, "İstemi göster") : null);
      if (ev.toolUseId) {
        S.spawnLinks.push({ toolUseId: ev.toolUseId, slot });
        resolveSpawn(ev.toolUseId, slot);
      }
      return box;
    }
    if (kind === "search" || kind === "read" || kind === "edit" || kind === "write") return null;
    if (ev.text && /^\s*cd\s/.test(ev.text)) return commandBlock(ev.text); // e.g. Monitor { command }
    return null;
  }

  /** Humanized command (cd prefix dropped, paths shortened); the raw command is in the tooltip. */
  function commandBlock(raw) {
    const hc = humanizeCommand(raw, pathCtx);
    const pre = h("pre", { class: "cmd", title: hc.changed ? hc.full : "" }, h("code", { text: hc.body || raw }));
    pre.addEventListener("click", () => pre.classList.toggle("open"));
    return pre;
  }

  function oneLineHuman(text) {
    if (!text) return "";
    return /^\s*cd\s/.test(text) ? humanizeCommand(text, pathCtx).head : shortenPaths(text, pathCtx);
  }

  function resolveSpawn(toolUseId, slot) {
    if (slot.childElementCount > 0) return true;
    const d = getDetail();
    const target = d ? findByToolUse(d.tree, toolUseId) : null;
    if (!target) return false;
    slot.append(h("button", { class: "link", onclick: () => onOpenAgent(target.key) }, h("span", { class: `dot ${target.state}` }), h("span", { text: "Ajanı aç" }), icon("chevronRight")));
    return true;
  }

  function attachResult(card, ev) {
    card.status.replaceChildren(ev.isError ? icon("alert", "err") : icon("check", "ok"));
    card.card.classList.toggle("has-error", Boolean(ev.isError));
    card.resultSlot.hidden = false;
    card.resultSlot.replaceChildren(resultBlock(ev));
  }

  /** Tool results are always collapsed to one preview line; errors are labelled. */
  function resultBlock(ev) {
    const text = ev.text ?? "";
    const lines = text.split("\n");
    const first = shortenPaths(lines.find((l) => l.trim().length > 0) ?? "(boş sonuç)", pathCtx);
    const multi = lines.length > 1 || first.length > 140;
    const full = h("pre", { class: "rs-full", hidden: true }, h("code", { text }));
    const toggle = h("button", { class: `rs-toggle${ev.isError ? " err" : ""}`, "aria-expanded": "false", disabled: !multi },
      icon("chevronRight", "chev"),
      h("span", { class: "rs-label", text: ev.isError ? "Hata" : "Sonuç" }),
      h("span", { class: "rs-preview mono", text: first.length > 140 ? `${first.slice(0, 139)}…` : first }),
      multi ? h("span", { class: "rs-lines num", text: `${lines.length} satır` }) : null);
    toggle.addEventListener("click", () => {
      const open = full.hidden;
      full.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("open", open);
    });
    return h("div", { class: "result" }, toggle, full);
  }

  // ---- public ----------------------------------------------------------------------------------------
  return {
    open(sid, key) {
      const same = S.sid === sid && S.key === key;
      S.sid = sid;
      S.key = key;
      root.hidden = false;
      renderHead();
      if (!same || S.cursor === null) {
        S.cursor = null;
        S.gen++;
        reset();
        showSkeleton();
        void loadInitial();
      }
      feed.focus({ preventScroll: true });
    },
    close() {
      root.hidden = true;
      S.key = null;
      S.cursor = null;
      S.gen++;
    },
    refresh() {
      if (!S.key) return;
      const d = getDetail();
      if (!d || d.id !== S.sid || !findNode(d.tree, S.key)) return;
      renderHead();
      S.spawnLinks = S.spawnLinks.filter((l) => !resolveSpawn(l.toolUseId, l.slot));
      void poll();
    },
    tick(now) {
      const v = facts.querySelector("[data-since]");
      if (v) v.textContent = fmtDur(now - Number(v.getAttribute("data-since")));
    },
    get isOpen() {
      return S.key !== null;
    },
  };
}

function findByToolUse(n, id) {
  if (n.toolUseId === id) return n;
  for (const c of n.children) {
    const r = findByToolUse(c, id);
    if (r) return r;
  }
  return null;
}

/** apply_patch body (Codex) as per-file +/- blocks; see parsePatch in diff.js. */
function patchView(text) {
  const { files } = parsePatch(text);
  if (files.length === 0) return h("pre", { class: "code-block" }, h("code", { text }));
  let budget = 80;
  const OPS = { update: "düzenlendi", add: "eklendi", delete: "silindi" };
  return h("div", { class: "patch-list" }, ...files.map((f) => {
    const rows = f.rows.slice(0, Math.max(0, budget));
    budget -= rows.length;
    const el = h("div", { class: "diff mono" }, ...rows.map((r) =>
      r.k === "hunk" ? diffLine("gap", "@@", r.t) : diffLine(r.k, r.k === "del" ? "−" : r.k === "add" ? "+" : " ", r.t || " ")));
    if (f.rows.length > rows.length) el.append(diffLine("gap", "⋯", `${f.rows.length - rows.length} satır daha gösterilmiyor`));
    return h("div", { class: "patch" },
      h("div", { class: "patch-file mono" }, h("span", { class: "muted", text: OPS[f.op] ?? f.op }), h("span", { text: shortenPaths(f.moveTo ? `${f.path} → ${f.moveTo}` : f.path, pathCtx) }), h("span", { class: "grow" }),
        h("span", { class: "diff-stat num" }, h("span", { class: "ds-add", text: `+${f.add}` }), h("span", { class: "ds-del", text: `−${f.del}` }))),
      f.rows.length ? el : null);
  }));
}

function diffLine(k, mark, content) {
  return h("div", { class: `dl ${k}` }, h("span", { class: "dm", text: mark }), h("span", { class: "dt" }, ...(Array.isArray(content) ? content : [content])));
}

/** Line diff (LCS, folded context, intra-line highlight) as DOM; see diff.js. */
function diffView(oldS, newS) {
  const { rows } = lineDiff(oldS, newS);
  const MAX = 80;
  const el = h("div", { class: "diff mono" }, ...rows.slice(0, MAX).map((r) =>
    r.k === "gap"
      ? diffLine("gap", "⋯", `${r.n} değişmeyen satır`)
      : diffLine(r.k, r.k === "del" ? "−" : r.k === "add" ? "+" : " ", r.segs ? r.segs.map((sg) => (sg.hl ? h("mark", { text: sg.t }) : sg.t)) : [r.t || " "])));
  if (rows.length > MAX) el.append(diffLine("gap", "⋯", `${rows.length - MAX} satır daha gösterilmiyor`));
  return el;
}
