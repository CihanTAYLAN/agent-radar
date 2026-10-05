// Shell command humanizer. Pure functions (no DOM) so the server-side test suite can import them.
//
// Agents run commands like `cd /Users/me/proj/.claude/worktrees/agent-a1b2/api && npm test` or
// `cat /private/tmp/claude-501/-Users-me-proj/<session>/tasks/x.output`; the interesting part is
// buried behind the path. This splits a leading `cd <dir> &&` off (shown as a small chip) and
// shortens well-known absolute paths:
//   <anything>/.claude/worktrees/<name>/rest     -> wt:<name>/rest
//   /private/tmp/claude-<uid>/<project>/<sid>/x  -> tmp:/x
//   <session cwd>/x                              -> ./x
//   <home>/x                                     -> ~/x

const CD_PREFIX = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;
const WORKTREE = /^.*?\/\.claude\/worktrees\/([^/]+)(\/.*)?$/;
const CLAUDE_TMP = /^(?:\/private)?\/tmp\/claude-\d+(?:\/[^/]+(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)?(\/.*)?$/i;
// An absolute path token: starts after whitespace, a quote, `=`, `:` `(` or at the beginning.
const PATH_TOKEN = /(^|[\s'"=:(<>|])(\/[^\s'"`;|&<>()]+)/g;

/**
 * @typedef {{ home?: string, cwd?: string }} PathCtx
 * @typedef {{ dir: string | null, rawDir: string | null, head: string, body: string, full: string, changed: boolean }} HumanCmd
 */

const trimSlash = (/** @type {string} */ p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * Split leading `cd <dir> &&` / `cd <dir>;` prefixes off a command (the last one wins).
 * @param {string} cmd
 * @returns {{ dir: string | null, rest: string }}
 */
export function splitCd(cmd) {
  let rest = cmd;
  /** @type {string | null} */
  let dir = null;
  for (let i = 0; i < 4; i++) {
    const m = CD_PREFIX.exec(rest);
    if (!m) break;
    const raw = m[1] ?? "";
    dir = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") ? raw.slice(1, -1) : raw;
    rest = rest.slice(m[0].length);
  }
  return dir !== null && rest.trim() ? { dir, rest } : { dir: null, rest: cmd };
}

/**
 * Shorten one absolute path. Returns it unchanged when no rule applies.
 * @param {string} p
 * @param {PathCtx} [ctx]
 */
export function shortenPath(p, ctx = {}) {
  if (!p || p[0] !== "/") return p;
  const wt = WORKTREE.exec(p);
  if (wt) return `wt:${wt[1]}${wt[2] && wt[2] !== "/" ? wt[2] : ""}`;
  const tmp = CLAUDE_TMP.exec(p);
  if (tmp) return `tmp:${tmp[1] && tmp[1] !== "/" ? tmp[1] : "/"}`;
  const cwd = ctx.cwd ? trimSlash(ctx.cwd) : "";
  if (cwd && cwd !== "/" && (p === cwd || p.startsWith(`${cwd}/`))) {
    const rest = p.slice(cwd.length);
    return rest && rest !== "/" ? `.${rest}` : ".";
  }
  const home = ctx.home ? trimSlash(ctx.home) : "";
  if (home && home !== "/" && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * Shorten every absolute path token inside free text (a command line, a summary).
 * @param {string} text
 * @param {PathCtx} [ctx]
 */
export function shortenPaths(text, ctx = {}) {
  if (!text || !text.includes("/")) return text ?? "";
  return text.replace(PATH_TOKEN, (_m, pre, path) => `${pre}${shortenPath(path, ctx)}`);
}

/**
 * Humanize a shell command for display.
 * - `dir`: shortened `cd` target, or null (also null when it is just the session cwd).
 * - `head`: first meaningful line, paths shortened, whitespace collapsed (for one-line slots).
 * - `body`: the whole command without the `cd` prefix, paths shortened (multi-line kept).
 * - `full`: the raw command as given; `changed` says whether `body` differs from it.
 * @param {string} cmd
 * @param {PathCtx} [ctx]
 * @param {string | null} [dirHint] a `cd` dir already split off upstream (server ToolAction.dir)
 * @returns {HumanCmd}
 */
export function humanizeCommand(cmd, ctx = {}, dirHint = null) {
  const full = String(cmd ?? "");
  const sp = splitCd(full);
  const rawDir = sp.dir ?? dirHint ?? null;
  let dir = rawDir ? shortenPath(rawDir, ctx) : null;
  if (dir === ".") dir = null;
  const body = shortenPaths(sp.rest.replace(/^\s+/, "").replace(/\s+$/, ""), ctx);
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const more = body.split("\n").filter((l) => l.trim().length > 0).length > 1;
  const head = `${firstLine.replace(/\s+/g, " ").trim()}${more ? " …" : ""}`;
  return { dir, rawDir, head, body, full, changed: body !== full.trim() || rawDir !== null };
}
