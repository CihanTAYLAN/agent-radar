# Providers

Every AI agent tool agent-radar understands is a **provider**: one folder under `src/providers/<id>/`
that turns that tool's on-disk data into the neutral shapes in [`types.ts`](./types.ts). The rest of
the app (`src/store.ts`, `src/server.ts`, `public/`) only ever sees those shapes.

```
src/providers/
  types.ts          Provider interface + neutral shapes (SessionSummary, AgentNode, StreamEvent, ...)
  common.ts         shared helpers: global session ids, usage math, clipLine/splitCdPrefix, time buckets
  guard.ts          path deny-list every provider must use before reading a file
  index.ts          the registry (one line per provider)
  sqlite.ts         shared read-only node:sqlite loader (loadSqlite)
  claude-code/      Claude Code (~/.claude)
  codex/            OpenAI Codex CLI + Codex desktop (~/.codex)
  antigravity/      Google Antigravity (~/.gemini/antigravity*, summary-only)
  opencode/         opencode and Kilo Code (SQLite under $XDG_DATA_HOME, one family)
  bionic/           Bionic (~/.lmstudio/apps/bionic, SQLite)
  gemini-cli/       Google Gemini CLI (~/.gemini/tmp/*/chats)
```

## The contract

A provider implements `Provider` (see `types.ts`):

| Member | Meaning |
| --- | --- |
| `id`, `label` | Stable id (`"codex"`) and display name (`"Codex"`). |
| `loading` | True until the first discovery pass finished. |
| `start()` / `stop()` / `scan(full?)` | Lifecycle. `scan` must be safe to call concurrently; `full` forces re-discovery. |
| `onChange(fn)` | Call `fn(ids)` after a scan with the **global** ids of sessions that changed. |
| `listSessions()` | `SessionSummary[]` with global `id` and `provider` set. |
| `isSessionId(nativeId)` | Validates an id from the URL (without the `<provider>:` prefix). Ids are never used to build paths. |
| `getSession(nativeId)` | `SessionDetail`: summary + agent tree (`AgentNode`, main + subagents, recursively) + usage by model. |
| `readEvents(nativeId, agentKey, {tail, after, before})` | A page of `StreamEvent`s with byte cursors (`cursor`, `start`). `agentKey` is `"main"` or a child key. |
| `machine()` | Counters for the top bar; the store sums them across providers. |
| `status()` | `ProviderStatus`: installed / data found / sessions / active / last activity / capabilities / notes. |

Rules:

- **Read-only.** No fs writes, no `child_process`, `process.kill(pid, 0)` at most.
  `tests/readonly.test.ts` scans every file under `src/` for this.
- **Deny-list.** Check every path with `isDeniedPath()` / `safeToRead()` from `guard.ts` before
  opening it; never read auth, token, credential, key or config files.
- **Mask everything you serve.** Use `safeText` / `maskSecrets` / `clipLine` for every string that
  can contain user data (text, commands, paths, titles).
- **Global ids.** Build session ids with `sessionKey(providerId, nativeId)`. The `claude-code`
  provider owns the bare namespace (for old deep links); every other provider gets
  `<providerId>:<nativeId>`, so ids cannot collide.
- **Degrade honestly.** If the tool does not expose something, say so in `capabilities` and
  `notes` (e.g. `tokens: false`, "yalnızca özet", "doğrulanmadı"); the UI hides tiles accordingly.
  Unknown model prices are reported with `costPartial: true`, never guessed.
- **Stay defensive.** Formats are internal and change; skip unknown line types, never throw on bad data.

## Adding a provider

1. Create `src/providers/<id>/` with a `format.ts` (all on-disk format knowledge), a
   `provider.ts` (discovery, tailing, aggregation) and an `index.ts` exporting a `ProviderFactory`:

   ```ts
   export const myTool: ProviderFactory = {
     id: "my-tool",
     label: "My Tool",
     create: (ctx) => new MyToolProvider({ home: ctx.env["MY_TOOL_HOME"] || join(ctx.userHome, ".my-tool"), recentMs: ctx.recentMs }),
   };
   ```

2. Add one line to `PROVIDERS` in `src/providers/index.ts`.
3. Add tests under `tests/` with **synthetic** fixtures only (never copy real transcripts).
4. Optional: a letter mark and label for the UI badge in `public/util.js` (`PROVIDER_META`); without
   it the UI uses the `mark`/`label` from `status()`.

Nothing else in the app needs to change.
