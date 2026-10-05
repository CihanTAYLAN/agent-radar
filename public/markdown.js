// Minimal, safe markdown -> DOM renderer. Builds nodes with textContent only: raw HTML in the source is
// shown as text, never parsed. Supports: headings, paragraphs, fenced code, blockquotes, flat/nested
// lists, pipe tables, hr, and inline code / bold / italic / strike / links (http, https, mailto only).

import { h } from "./util.js";

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text, out, inLink = false) {
  // Order matters: code spans first so their content is literal.
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*\n]*?)\*(?!\w)|(?<![\w_])_([^_\s][^_\n]*?)_(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.append(text.slice(last, m.index));
    if (m[1] !== undefined) out.append(h("code", { text: m[2] }));
    else if (m[3] !== undefined || m[4] !== undefined) out.append(inlineEl("strong", m[3] ?? m[4], inLink));
    else if (m[5] !== undefined) out.append(inlineEl("del", m[5], inLink));
    else if (m[6] !== undefined) {
      const url = m[7];
      if (SAFE_URL.test(url) && !inLink) out.append(link(url, m[6]));
      else out.append(inlineEl("span", m[6], inLink));
    } else if (m[8] !== undefined || m[9] !== undefined) out.append(inlineEl("em", m[8] ?? m[9], inLink));
    // A bare URL is its own label (plain text, so it is not matched again); no links inside links.
    else if (m[10] !== undefined) out.append(inLink ? m[10] : h("a", { href: m[10], target: "_blank", rel: "noopener noreferrer", text: m[10] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.append(text.slice(last));
  return out;
}

function link(href, label) {
  const a = h("a", { href, target: "_blank", rel: "noopener noreferrer" });
  inline(label, a, true);
  return a;
}

function inlineEl(tag, text, inLink = false) {
  return inline(text, h(tag), inLink);
}

const isFence = (l) => /^\s{0,3}(```|~~~)/.test(l);
const isHr = (l) => /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l);
const isQuote = (l) => /^\s{0,3}>/.test(l);
const listRe = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

function splitRow(l) {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function renderMarkdown(src) {
  const root = h("div", { class: "md" });
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const fence = line.trim().slice(0, 3);
      const lang = line.trim().slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      const pre = h("pre", { class: "md-code" }, h("code", { text: body.join("\n") }));
      if (lang) pre.setAttribute("data-lang", lang.split(/\s/)[0]);
      root.append(pre);
      continue;
    }
    if (isHeading(line)) {
      const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      const level = Math.min(6, (m?.[1].length ?? 1) + 2); // h3..h6 inside cards
      root.append(inlineEl(`h${Math.min(level, 6)}`, m?.[2] ?? line));
      i++;
      continue;
    }
    if (isHr(line)) {
      root.append(h("hr"));
      i++;
      continue;
    }
    if (isQuote(line)) {
      const body = [];
      while (i < lines.length && isQuote(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      const bq = h("blockquote");
      bq.append(...renderMarkdown(body.join("\n")).childNodes);
      root.append(bq);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      const table = h(
        "table",
        null,
        h("thead", null, h("tr", null, head.map((c) => inlineEl("th", c)))),
        h("tbody", null, rows.map((r) => h("tr", null, head.map((_, k) => inlineEl("td", r[k] ?? ""))))),
      );
      root.append(h("div", { class: "md-table" }, table));
      continue;
    }
    if (listRe.test(line)) {
      root.append(parseList(lines, () => i, (v) => (i = v)));
      continue;
    }
    // Paragraph: until blank line or another block start.
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isFence(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) && !listRe.test(lines[i]) && !isHr(lines[i])) {
      if (para.length > 0 && lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      para.push(lines[i++].trim());
    }
    const p = h("p");
    para.forEach((l, k) => {
      if (k > 0) p.append(h("br"));
      inline(l, p);
    });
    root.append(p);
  }
  return root;
}

function parseList(lines, get, set) {
  let i = get();
  const first = listRe.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? "ol" : "ul");
  if (ordered) {
    const start = parseInt(first[2], 10);
    if (start > 1) list.start = start;
  }
  let li = null;
  while (i < lines.length) {
    const l = lines[i];
    const m = listRe.exec(l);
    if (m && m[1].length === baseIndent) {
      li = h("li");
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      if (task) {
        li.classList.add("task");
        li.append(h("span", { class: `tick${task[1] !== " " ? " on" : ""}`, text: task[1] !== " " ? "✓" : "" }));
        inline(task[2], li);
      } else inline(m[3], li);
      list.append(li);
      i++;
    } else if (m && m[1].length > baseIndent && li) {
      set(i);
      li.append(parseList(lines, get, set));
      i = get();
    } else if (!m && li && /^\s{2,}\S/.test(l)) {
      li.append(" ");
      inline(l.trim(), li);
      i++;
    } else break;
  }
  set(i);
  return list;
}
