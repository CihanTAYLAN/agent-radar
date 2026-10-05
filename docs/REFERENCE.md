# agent-radar reference

A local, **read-only** web dashboard for AI coding agents on this machine. It monitors **Claude Code**,
**OpenAI Codex** (CLI + desktop), **Google Antigravity**, **opencode**, **Kilo Code**, **Bionic** and
**Gemini CLI**; each tool is a provider module (`src/providers/`), so more can be added independently.
It shows every session, its subagent tree, a live activity stream, token usage and cost estimates where
the tool exposes them, and updates live (Server-Sent Events) without page reloads. The UI is Turkish.

## Supported tools

What each provider can show. "Verified" means the on-disk format was checked against real data on the
development machine (not only derived from source or docs).

| Tool | Data root | Transcript | Tokens | Tools | Subagents | Cost | Verified |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Claude Code | `~/.claude` | yes | yes | yes | yes | yes (official prices) | yes |
| Codex | `~/.codex` | yes | yes | yes | yes | yes (official prices, listed models) | yes |
| Antigravity | `~/.gemini/antigravity*` | no (summary only) | no | no | yes | no | yes |
| opencode | `$XDG_DATA_HOME/opencode/opencode.db` | yes | yes | yes | yes | yes (tool's own `session.cost`) | yes |
| Kilo Code | `$XDG_DATA_HOME/kilo/kilo.db` | yes | yes | yes | yes | yes (tool's own `session.cost`) | yes |
| Bionic | `~/.lmstudio/apps/bionic` | yes | no | yes | yes | no | yes |
| Gemini CLI | `~/.gemini/tmp/*/chats` | yes | yes | yes | no | no (no price table) | no (derived from source) |

A provider whose tool is not installed simply shows as absent in the "Ajanlar" panel. Where a tool does not
expose something, the UI says so instead of showing zeros.

- **Machine view**: sessions grouped by project/cwd. Live sessions (registry entry + process alive)
  are highlighted with status (`busy`/`idle`), name, entrypoint and uptime. Sessions whose
  transcript changed in the last 24 h but are not live are listed collapsed and dimmed.
- **Agent tree**: main agent, then subagents nested by the `Agent`/`Task` tool call that spawned
  them. Each node: description, agent type, model, background/foreground, state
  (`running` / `done` / `failed` / `stopped` / `stalled`), duration, token totals, current tool.
- **Live stream**: for the selected agent (main or subagent), tool calls (tool + short input
  summary), truncated results, assistant text. Auto-tails; click a result to expand it.
- **Cost / usage**: input / output / cache-read / cache-write tokens per agent, per session,
  and per model, taken from `message.usage`.

## Run

### Requirements

- **Node.js 22.13.0 or newer** (`.nvmrc` pins the major, `22`). The Codex, opencode, Kilo Code, Bionic and
  Antigravity providers read SQLite through `node:sqlite`, which needs no flag only from 22.13.0 (22.12.0 and
  older do not have it). On an older Node the server stops at startup with a clear message.
- **git** (to clone and update).
- Nothing else: no database, no Docker, no other services, no build step. The only runtime dependency is `tsx`.

Install Node with nvm on Ubuntu / WSL:

```sh
sudo apt-get update && sudo apt-get install -y curl git ca-certificates
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal (or: . ~/.nvm/nvm.sh), then, inside the cloned repo:
nvm install        # reads .nvmrc, installs the latest Node 22
node -v            # v22.13.0 or newer
```

### Install and start

```sh
git clone <your-repo-url> agent-radar
cd agent-radar
npm ci
npm start          # plain start (tsx src/index.ts)
# or
npm run dev        # tsx watch, restarts on source changes
```

Then open <http://localhost:4747> (or `http://127.0.0.1:4747`). The startup line lists every provider with the
data root it resolved and `(not found)` for tools that are not installed. Deep link to a session/agent/view:
`#s=<sessionId>&a=<agentId>&v=cost` (editing the hash in place switches the view).

Other commands:

```sh
npm test            # vitest: parsing, masking, tailing, store, HTTP (fixtures only, no real transcripts)
npm run typecheck   # tsc --noEmit
```

### Opening it from Windows (WSL2)

The server binds `127.0.0.1` inside WSL. With WSL2's default localhost forwarding (or
`networkingMode=mirrored`), open <http://localhost:4747> in the Windows browser.

The server only accepts loopback `Host` headers (DNS-rebinding guard), so use `localhost` or `127.0.0.1`.
Opening it through the WSL IP address (`http://172.x.x.x:4747`) is answered with `403` by design.

If the page does not load:

1. Check that the server listens inside WSL: `ss -ltnp | grep 4747` (expect `127.0.0.1:4747`).
2. Make sure localhost forwarding is on. In `C:\Users\<you>\.wslconfig`:
   ```ini
   [wsl2]
   localhostForwarding=true
   ```
   (or `networkingMode=mirrored` on recent Windows 11 builds).
3. Restart WSL from PowerShell so the config is applied: `wsl --shutdown`, then open the distro again and
   start agent-radar again.
4. Try `http://127.0.0.1:4747` instead of `localhost` (or the other way round), and check that another program
   is not using the port (`ss -ltnp | grep 4747` shows the owner).

### Which agents it sees

agent-radar reads the data directories of the **Linux user it runs as**. Agents running inside WSL (Claude Code
CLI, Codex CLI, opencode, Gemini CLI, Kilo CLI) work out of the box. Agents running on the **Windows side**
(for example the Claude, ChatGPT or Codex desktop apps on Windows) keep their data under
`C:\Users\<user>\...`, which WSL sees as `/mnt/c/Users/<user>/...`. To read that instead, point the provider at
it with the variables below (quote the path if it contains spaces):

```sh
export CLAUDE_CONFIG_DIR=/mnt/c/Users/<user>/.claude
export CODEX_HOME=/mnt/c/Users/<user>/.codex
export ANTIGRAVITY_HOME=/mnt/c/Users/<user>/.gemini        # holds antigravity/ and antigravity-ide/
export GEMINI_CLI_HOME=/mnt/c/Users/<user>                 # the directory that CONTAINS .gemini
export BIONIC_HOME=/mnt/c/Users/<user>/.lmstudio/apps/bionic
export XDG_DATA_HOME=/mnt/c/Users/<user>/.local/share      # opencode and Kilo Code (both move together)
npm start
```

Limits to know:

- **One root per provider.** Each provider reads exactly one root at a time. WSL and Windows at the same time
  is not supported: pick the side where that tool actually runs (a tool installed on both sides needs two
  radar instances on two ports, started with different variables).
- **Liveness.** "Live" for Claude Code is a registry entry plus a process check (`kill(pid, 0)`). Windows
  process ids mean nothing inside WSL, so for Windows-side Claude Code sessions the live flag is unreliable
  (usually shown as not live, and a pid collision can show a dead session as live).
- **`/mnt/c` is slow.** File watching on `/mnt/c` (9P) is slower and less reliable than on the Linux
  filesystem. The radar falls back to polling (2 s for active sessions, 15 s full re-discovery), so changes can
  show up with a delay.

### Configuration

All optional. Variables are read from the environment of the process; the host is always `127.0.0.1`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `--port N` / `AGENT_RADAR_PORT` / `PORT` | `4747` | HTTP port (in that order of precedence). |
| `AGENT_RADAR_RECENT_HOURS` | `24` | How far back non-live sessions are listed (by transcript mtime / thread update time). |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config dir to read. |
| `CODEX_HOME` | `~/.codex` | Codex home to read. |
| `ANTIGRAVITY_HOME` | `~/.gemini` | Directory holding the `antigravity/` and `antigravity-ide/` data dirs. |
| `GEMINI_CLI_HOME` | `~` | Directory that *contains* `.gemini` (the Gemini CLI convention); chats are read from `.gemini/tmp`. |
| `BIONIC_HOME` | `~/.lmstudio/apps/bionic` | Bionic app dir. |
| `XDG_DATA_HOME` | `~/.local/share` | Base dir of the opencode (`opencode/opencode.db`) and Kilo Code (`kilo/kilo.db`) stores. |
| `AGENT_RADAR_SUMMARIZER` | unset (off) | `codex` turns on the optional topic summaries (see below). Any other value keeps it off. |
| `AGENT_RADAR_SUMMARIZER_MODEL` | `gpt-6-luna` | Model passed to `codex exec -m`. |
| `AGENT_RADAR_SUMMARIZER_MAX_PER_HOUR` | `20` | Cap of summary calls per hour. |
| `AGENT_RADAR_CODEX_BIN` | unset | Path of the Codex CLI binary to use for summaries. |

`PATH` is also read (only to find `codex` and `gemini`). No other environment variable is used.

### Topic summaries (optional, off by default)

`AGENT_RADAR_SUMMARIZER=codex` runs `codex exec` per changed topic through your own Codex subscription. It
**sends masked excerpts (at most 2000 characters) to OpenAI**, and only when it is on. Binary resolution:

- **Linux / WSL:** `AGENT_RADAR_CODEX_BIN`, then `codex` found on `PATH` (the PATH directories are scanned with
  `fs.access`; no `which` or shell is run).
- **macOS:** `AGENT_RADAR_CODEX_BIN`, then the ChatGPT.app bundle, then Homebrew.

On WSL this requires the **Codex CLI installed in WSL** and logged in (`codex login`). With a ChatGPT account,
older CLI versions reject the default model `gpt-6-luna`: update the Codex CLI in WSL
or choose another model with `AGENT_RADAR_SUMMARIZER_MODEL`. If the CLI is missing the settings menu shows
the reason and summaries stay off.

```sh
AGENT_RADAR_SUMMARIZER=codex AGENT_RADAR_SUMMARIZER_MODEL=<model> npm start
```

### Running in the background

With tmux (survives closing the terminal, you can re-attach):

```sh
tmux new-session -d -s agent-radar 'cd ~/agent-radar && npm start'
tmux attach -t agent-radar        # Ctrl-b d to detach again
```

or with nohup:

```sh
cd ~/agent-radar
nohup npm start > agent-radar.log 2>&1 &
```

Optionally, as a systemd user service (WSL with systemd enabled, `systemd=true` in `/etc/wsl.conf`). Save as
`~/.config/systemd/user/agent-radar.service`:

```ini
[Unit]
Description=agent-radar (read-only agent dashboard)

[Service]
ExecStart=/bin/bash -c '. "$HOME/.nvm/nvm.sh" && cd "$HOME/agent-radar" && exec npm start'
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-radar
journalctl --user -u agent-radar -f      # logs
```

### Updating

```sh
cd ~/agent-radar
git pull && npm ci
```

then restart (stop it as below and start it again; `systemctl --user restart agent-radar` for the service).

### Stopping

Stop by port, never by process-name pattern:

```sh
# Linux / WSL
fuser -k 4747/tcp                                   # from the psmisc package
kill $(ss -H -ltnp 'sport = :4747' | grep -o 'pid=[0-9]*' | cut -d= -f2)    # same, with ss only

# macOS
lsof -tiTCP:4747 -sTCP:LISTEN | xargs kill
```

In the foreground, Ctrl-C stops it. In tmux: `tmux kill-session -t agent-radar` also works.

## Safety properties

- **Read-only.** The code never writes to `~/.claude`, never spawns processes and only calls
  `process.kill(pid, 0)` (existence check, no signal is delivered). `tests/readonly.test.ts`
  enforces this by scanning the sources for any fs-mutation API or non-zero `kill`.
- **Loopback only.** The server binds to `127.0.0.1`; requests whose `Host` header is not a
  loopback name are rejected (DNS-rebinding guard). Only `GET`/`HEAD` are served. Ids from the URL
  are validated and never used to build file paths (paths come from the server's own index).
  A strict CSP is set and the UI only ever uses `textContent`.
- **Secrets.** `sessions/*.key` files are never read, watched or served. Everything sent to the UI
  passes through best-effort masking (`sk-...`, `ghp_...`, `AKIA...`, `Bearer ...`, JWTs, PEM private
  key blocks, `KEY=`/`TOKEN=`/`PASSWORD=`/`SECRET=` values). Tool results are truncated to 2 KB.
  Masking is a safety net, not a guarantee: treat the UI as sensitive, it shows your prompts and
  tool output.

- **Deny-list.** Every provider checks each path with `src/providers/guard.ts` before opening it: file names
  matching `auth`, `token`, `credential`, `secret`, `password`, `.env*`, `config.toml`, `*.key` / `*.pem` /
  `*.p12` / `*.pfx` / `*.keystore`, `id_rsa`-style keys and `.netrc` are never read, and reads must stay inside
  the provider's own roots. SQLite stores are opened with `{ readOnly: true }` per pass and closed right after;
  only the one database each provider needs is opened. `tests/readonly.test.ts` scans `src/` for any
  fs-mutation API, `child_process` and non-zero `kill`.

## Pricing sources

Costs are **estimates**, never a bill. Prices live in `src/pricing.ts` (USD per 1M tokens, standard tier,
exact model-name matching): Claude models come from Anthropic's official pricing page and OpenAI models
from OpenAI's official pricing page, both read on 2026-09-29 and marked `verified` with that source.
Long-context surcharges are not applied. A model without an entry has no price ("—", partial cost), never
a guess. opencode and Kilo Code report their own `session.cost`, which is shown as is. Gemini CLI, Bionic
and Antigravity have no cost figures.

## Data sources

The sections below describe Claude Code and Codex in detail; the other providers document their formats at
the top of their `format.ts` / `provider.ts`.

All under `~/.claude`. **Every format detail lives in `src/providers/claude-code/format.ts`**; when
Claude Code changes its files, that is the one place to fix.

| Path | Used for |
| --- | --- |
| `sessions/<pid>.json` | Live registry: pid, sessionId, cwd, startedAt, name, entrypoint, status. Liveness = `process.kill(pid, 0)`. |
| `projects/<encoded-cwd>/<sid>.jsonl` | Main transcript (tokens, tool calls, `Agent` spawns, task notifications, titles). |
| `projects/<encoded-cwd>/<sid>/subagents/agent-<id>.jsonl` | Subagent transcripts (also under `subagents/workflows/<wf>/`). |
| `.../agent-<id>.meta.json` | agentType, description, toolUseId (parent link), spawnDepth, requestShape, model. Optional. |
| `.../<sid>/custom-title.json` | Session title fallback. |

How things are derived:

- **Tail, don't re-read.** Each transcript is read by byte offset; only newline-terminated lines are
  consumed, so an in-flight partial line is picked up on the next pass. Truncation resets the offset.
  Aggregates are kept in memory; events for the stream are read on demand from disk by cursor.
- **Tokens.** One API message is written as several lines (one per content block) that repeat the
  same `usage`; usage is de-duplicated by `message.id` (last line wins).
- **Nesting.** `meta.toolUseId` -> the `Agent` tool_use block found in whichever transcript
  (main or another subagent) contains it. Without a meta file, the parent's `Agent` tool_result
  (`toolUseResult.agentId`) provides the link and description; otherwise the agent hangs off main.
- **State.** `<task-notification>` messages in the parent transcript (`completed`/`failed`/`killed`/
  `stopped`) win if nothing happened after them. Otherwise: last assistant entry with a final
  `stop_reason` = `done`; unfinished and active in the last 10 min = `running`; unfinished and silent
  longer = `stalled`. The main agent follows the registry status while the process is alive.
- **Updates.** `fs.watch` (recursive) triggers debounced scans, plus a 2 s poll of active sessions
  and a 15 s full re-discovery, so it still works where watching is unreliable.

## Codex (`~/.codex`)

All format knowledge lives in `src/providers/codex/format.ts` (rollouts) and
`src/providers/codex/index-db.ts` (index).

| Path | Used for |
| --- | --- |
| `state_<n>.sqlite` (`threads`, `thread_spawn_edges`) | Thread index: rollout path, cwd, model, title, source (desktop / cli / exec / subagent), parent links. Opened with `node:sqlite` `{ readOnly: true }` per discovery pass; `immutable` is not used (WAL). No other Codex database is opened. |
| `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` | Append-only thread rollouts, tailed by byte offset: turns, token usage, tool calls, messages. |
| `archived_sessions/rollout-*.jsonl` | Archived threads (never live; listed only inside the recent window). |

- **Deny-list.** `auth.json`, `config.toml` and any `*auth*` / `*token*` / `*credential*` / `*secret*` /
  `*.key` file is never opened (`src/providers/guard.ts`); rollout paths from the index must also lie
  inside `sessions/` or `archived_sessions/`. `tests/readonly.test.ts` asserts this.
- **Mapping.** A thread without a parent is a session (`codex:<thread id>`); subagent threads nest under
  their parent recursively. Without the database, discovery walks the recent date dirs and takes
  parent links from each rollout's `session_meta`.
- **Live heuristic** (no processes are inspected): *running* = an open turn (`task_started` without
  `task_complete` / `turn_aborted`) and the rollout changed in the last 10 min; else *idle* (live) if it
  changed in the last 2 min; else *done* (*stopped* if the last turn was aborted).
- **Tokens** come from `token_usage_record` (deduplicated by response id; OpenAI `input_tokens`
  includes cached input, which is split out), falling back to `token_count` totals for older rollouts.
- **Never shown:** reasoning `encrypted_content`, `base_instructions`, developer messages, encrypted
  inter-agent payloads. Huge lines (`world_state`, `item_completed`, tool outputs) are skipped unparsed
  for aggregates.
- **Cost.** OpenAI prices in `src/pricing.ts` are matched by exact model pattern; some are official verified prices (2026-09-29, standard tier),
  others are estimates. A model without an entry (e.g. new model names) has no cost ("—"), never a guess.

## Known limitations

- **The format is internal and undocumented** (verified against Claude Code 2.1.284). Field names,
  file layout or semantics can change without notice; parsing is defensive (unknown line types and
  malformed lines are skipped) but features can silently degrade.
- Agent state is an **inference**, not ground truth. A subagent waiting on a very long tool call for
  more than 10 minutes is shown as `stalled`; a crashed one that never wrote a final message may show
  `running` until the stall threshold passes.
- Token counts come from `message.usage`. Message ids were never seen in more than one transcript on the
  verification machine, but if a future version replays parent history into a subagent transcript,
  tokens would be counted in both. Dollar cost is not computed
  (prices are not in the transcripts).
- Liveness is `kill(pid, 0)` on the registry pid: a reused pid can show a dead session as live, and
  `EPERM` is treated as alive.
- Sessions whose main transcript is older than the recency window but which still have active
  subagents are not detected unless the session is live.
- Transcripts are trusted to be under `~/.claude/projects`; symlinks are followed as `fs` does.
- Encoded project directory names are lossy (`/` and `.` both become `-`), so the real `cwd` comes
  from the registry or the transcript; the directory name is only a last resort.
- A single machine, single user: no auth beyond the loopback binding. Do not expose the port.
- Codex: the live state is a heuristic (see above). A turn waiting more than 10 minutes on one tool
  call shows as done; the index lags new threads by up to one discovery pass (15 s); the schema changes
  fast (verified against Codex 0.158 / `state_5.sqlite`).
- WSL2: it only sees the data of the environment it runs in (Linux user inside WSL, or one Windows tree via
  the `/mnt/c` variables); see "Which agents it sees" under Run.

## Layout

```
src/providers/types.ts             provider interface + neutral shapes served by the API
src/providers/index.ts             provider registry (one line per provider)
src/providers/guard.ts             file deny-list (auth / token / credential / key / config files)
src/providers/claude-code/format.ts   all Claude Code on-disk format knowledge
src/providers/claude-code/provider.ts discovery, aggregation, agent tree, event reading for ~/.claude
src/providers/codex/format.ts      all Codex rollout format knowledge (lines, tool calls, events)
src/providers/codex/index-db.ts    read-only state_<n>.sqlite reader
src/providers/codex/provider.ts    Codex discovery, live heuristic, agent tree, event reading
src/providers/sqlite.ts            shared read-only node:sqlite loader
src/providers/antigravity/         Antigravity (summary-only), opencode/ (opencode + Kilo Code),
src/providers/bionic/              Bionic, gemini-cli/ Gemini CLI: format.ts + provider.ts (+ db.ts) each
src/mask.ts            secret masking + truncation
src/tail.ts            read-only incremental JSONL reading by byte offset
src/store.ts           aggregates the providers, routes session ids
src/server.ts          HTTP + SSE (127.0.0.1 only)
src/index.ts           entry point
public/                index.html, style.css, app.js and friends (no build step)
tests/                 vitest suites + tests/fixtures/claude-home (synthetic, no real data)
```

How to add another agent tool: see [`src/providers/README.md`](../src/providers/README.md).

API (all `GET`, JSON): `/api/health`, `/api/providers` (provider health), `/api/pricing`, `/api/sessions`, `/api/sessions/:id`,
`/api/sessions/:id/agents/:agentId/events?tail=N | after=<cursor>` (`agentId` = `main` for the main
agent), and `/api/stream` (SSE: `update` events carrying the session list and changed ids).

**Konular (topics).** `/api/topics?window=24h` groups the work being done across all tools by project + ticket key
(`PROJ-2742`), else PR, else normalised title; nothing new is collected (`src/topics.ts`, pure functions over the in-memory
session trees; touched modules and PR numbers come from the tool actions observed while the radar runs). Optional
model-written summaries are OFF by default: `AGENT_RADAR_SUMMARIZER=codex` runs one `codex exec --ephemeral -s read-only`
per changed topic through your own Codex subscription (model `AGENT_RADAR_SUMMARIZER_MODEL`, default `gpt-6-luna`; binary
`AGENT_RADAR_CODEX_BIN`, else (macOS) the ChatGPT.app bundle, else Homebrew, or (Linux) `codex` on PATH; cap `AGENT_RADAR_SUMMARIZER_MAX_PER_HOUR`, default 20).
Masked excerpts (<= 2000 chars) are sent to OpenAI only when it is on. `src/summarizer/codex.ts` is the single file allowed to
spawn a process (enforced by `tests/readonly.test.ts`). Status: `/api/settings` and the settings menu.
