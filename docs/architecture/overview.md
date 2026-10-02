# Architecture overview

atc multiplexes Claude Code, Grok Build, and Codex CLI sessions without a tiling layout engine: one
focused session owns the whole terminal, and every other session is reached through a
keyboard-driven overlay. The design bet is that the pain of many-session work is attention routing,
not window management. A per-user daemon hosts the sessions; disposable TUI clients drive them over
the [wire protocol](./protocol.md). Everything specific to one agent CLI lives in an adapter behind
the `AgentAdapter` interface, so a new agent CLI is an adapter, not a refactor.

## Process model

```text
atc (client TUI) ── NDJSON protocol ──> atcd (atc daemon)
                                         ├── PTY per session ──> claude --settings <generated>
                                         │                    or grok --no-leader, or codex
                                         ├── reporter socket (hook + statusline reports)
                                         ├── events socket (read-only NDJSON event stream)
                                         └── SQLite state in ~/.local/state/atc/
```

- The daemon owns the sessions; the first `atc` invocation boots it if its socket is absent, then
  connects as a thin client. Clients are disposable — quitting or crashing one leaves the fleet
  running. The [daemon architecture](./daemon.md) covers the internals.
- Each session is a `claude`, `grok`, or `codex` child process on its own PTY (`bun-pty`) inside the
  daemon. Attached clients receive the session's output as sequenced events; a slow client desyncs
  and resynchronizes rather than stalling the PTY or other clients.
- A per-session vt state machine (`@xterm/headless`) consumes every PTY byte continuously, so
  attaching is an instant serialized-screen replay — no reliance on the hosted agent repainting
  itself.
- `src/daemon/sessions.ts` is the state machine: session states are `running`, `needs_you`, `done`,
  `exited`, each with an `unread` attention flag.

## Sub-sessions

A sub-session is a session spawned from inside another session through the MCP server, which reads
the calling session's id from its environment. The sub-session lists indented under its parent and
sorts among its siblings alone, so its attention never moves the parent's row. It pins with its
parent, and a kill of the parent kills its live sub-sessions with it. The fleet table persists the
link by the parent's agent session id, so a restore rebuilds the set under fresh atc ids. A spawn
with `detached: true` makes a top-level session from inside a session.

## MCP server

`atc mcp` is a stdio MCP server and a client of the daemon: each tool call becomes one protocol
request. The tool definitions live in `src/mcp/mcp-tools.ts`, and each tool declares two things
beside its schema:

- Safety annotations, which `tools/list` returns. A read-scoped tool sets `readOnlyHint`. A tool
  that can end a session or type raw keystrokes into one sets `destructiveHint`. A tool that starts
  an agent or puts text in front of one sets `openWorldHint`, because the agent acts on that text
  outside atc's control.
- One scope out of `read`, `message`, `spawn`, and `kill`, which groups the tool by the access it
  needs. `atc_session_input` takes `spawn`, because raw keystrokes can do anything a new session
  can. The stdio server serves every scope to its caller; `atc mcp --http` serves only the scopes a
  client's grant holds, as [Remote MCP](./remote-mcp.md) describes.

Every tool result holds its output as text. A result that is data also holds it as
`structuredContent`, an object, and the message and event tools declare an `outputSchema` for it. A
tool whose data is a list keeps the bare list as its text and wraps it in an object for
`structuredContent`, so older clients read the same text.

The server returns the client's requested protocol version from `initialize` when it supports it
(`2025-11-25`, `2025-06-18`, or `2024-11-05`), else `2025-11-25`. The server leaves out
`2025-03-26`, which requires JSON-RPC batching that atc does not implement.

## Agents and gateways

A session records which agent it runs under as an id, and the daemon keys its adapter registry by
that id. The built-in ids are `claude`, `grok`, and `codex`. A configured gateway is an id of its
own: the Claude CLI against a Claude-compatible backend, with its own picker row, its own generated
settings file, and its own fleet rows. That settings file is passed to the terminal spawn and to a
headless turn alike, so ejecting a gateway session keeps it on its backend. A fleet row whose id has
no registered adapter keeps its place and refuses to revive, so a backend dropped from the config
never comes back as Claude.

`n` and `r` open an agent picker first. The picker resolves each agent's configured binary as it
opens and lists only the ones that resolve, so every row is a session that can start — an
uninstalled agent would otherwise show up three steps later as a PTY that dies on exec. A menu with
no rows at all carries the config keys to set.

The picker's opening selection is the last-used agent, advertised on `daemon.hello` and written on
the SessionStart of a deliberate spawn. A fleet restore does not stamp it, and MCP spawn ignores it
and defaults to Claude. An uninstalled last-used agent gives up the opening selection to the first
installed one.

## Agent integration

Claude sessions are instrumented via a generated settings file passed as `claude --settings`:

- Hooks (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) run
  `atc hook-report`, which forwards the event JSON to atc's unix socket. `SessionStart` carries the
  agent session id at spawn/resume time, which is what makes the fleet restorable before any
  interaction.
- The statusline command (`atc statusline`) chains the user's own configured statusline, then
  appends the fleet segment read from `status.json`, so fleet state renders inside Claude Code's own
  status line while attached. Its stdin JSON is also heartbeated to the socket as a second
  id-capture path.
- Session names are pulled from Claude's transcripts (`custom-title` lines from `/rename`, `summary`
  lines as fallback) — atc is not the naming authority.

Claude sessions also load the `atc-bridge` mod, a Claude Code plugin of function hooks. atc writes
it to `~/.local/state/atc/atc-bridge/` and passes it as `--plugin-dir`, and headless runs get it
through `CLAUDE_CODE_PLUGIN_DIRS`. The mod connects the session to its
[inbox](./protocol.md#messages):

- At session start it runs `atc tap` for the session. It submits each message as a new turn when the
  session is idle and appends it to the running turn otherwise, inside an `<atc-message>` envelope
  that holds the sender and message id.
- When a turn that carried messages ends with a reply, the mod reports every message the turn
  carried as answered with that reply and the turn's id, in one report. An aborted or failed turn
  leaves its messages delivered.
- It gives the model a `report` tool for progress mid-turn, which clients receive as a
  `SessionReport` event.

Outside atc, with no `ATC_SESSION_ID` in its environment, the mod does nothing.

Grok sessions take their hooks from a self-installed file at `$GROK_HOME/hooks/atc-reporter.json`;
the reporter forwards Grok's camelCase envelopes to the same socket. Grok names come from
`summary.json`. atc always appends `--no-leader` to the Grok spawn so the hosted TUI never swallows
the leader key.

Codex sessions take their hooks from self-installed entries in `$CODEX_HOME/hooks.json`, trusted
once in the Codex TUI. Codex names come from `session_index.jsonl`. The
[configuration guide](../guides/configuration.md#attention-hooks-grok-and-codex) covers the install
steps for both.

Headless handoff (eject a PTY session into a headless Agent SDK run and adopt it back) is
Claude-only: the Agent SDK and the CLI share the session store, and the handoff is sequential, so
the two never run the same session concurrently. Grok and Codex have no headless handoff — the
overlay hides `H` on their rows, and `session.eject` is `unsupported`.

The daemon writes a headless turn to the event trail itself, because the run has no terminal hooks:
`prompt-submitted` when the run starts, then `turn-done` or `needs-input` when it ends. The run's
whole final message becomes the session's latest result, the same as a terminal turn's. Hook reports
that arrive for a headless session stay out of the trail, so a gateway run's own hooks never
duplicate these events.

## State

All in `~/.local/state/atc/`:

| File          | Purpose                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atc.db`      | SQLite: the restorable fleet (rewritten on deliberate kills only; killed sessions persist as exited entries; each row holds the spawn prompt, model, effort, latest result, and transcript path), the hook-event trail, the message inbox, the spawn-directory history for the picker, and last-used agent (written on a deliberate-spawn SessionStart, advertised on `daemon.hello`). |
| `status.json` | Counts + most urgent session, read by the injected statusline on each render — a plain file because reporters read it without speaking the protocol.                                                                                                                                                                                                                                   |
| `mcp-auth.db` | SQLite: the OAuth state of `atc mcp --http` (clients, consent, token hashes), owned by that process and by `atc clients` and `atc grants`; the daemon never opens it. [Remote MCP](./remote-mcp.md) covers it.                                                                                                                                                                         |

`daemon.lock` is the lock that keeps one daemon per state directory, and `daemon.json` holds the
running daemon's pid and socket paths, so a client whose environment computes other socket paths
still finds it; the [daemon architecture](./daemon.md#one-daemon-per-state-directory) covers both.
The daemon also writes its pid file (`atc-daemon.pid`) beside its sockets in `$XDG_RUNTIME_DIR`.

## Recovery model

A client crash costs nothing — the daemon keeps hosting the fleet. If the daemon itself dies, its
children die with it (PTY close → SIGHUP), but each agent streams transcripts to disk continuously,
so sessions are data, not processes. Restore reconstructs each row with the matching CLI
(`claude --resume <id>`, `grok --resume <id>`, or `codex resume <id>`); the fleet table makes that a
single keypress (`R`) after a cold boot. The same mechanism powers adopt (`r`) and yank/eject
(`y`/`Y`). A session killed before its first exchange has nothing on disk yet, so revive (`P`)
reports that in the overlay's message column instead of resuming.

Reviving a whole fleet is incremental but visible from the start. Every fleet entry registers as a
session without a terminal before any process boots — each broadcasts `SessionAdded`, so clients
list the full incoming fleet immediately, marked "waiting to restore". Terminals then attach one at
a time in recency order (latest hook event in the trail first, from the events table): the first
attaches at once so the caller can attach, and each later one waits for the previous session to
report its `SessionStart` hook, so an update-triggered restart does not boot a dozen agent processes
in the same instant and stall the machine. A per-session cap (`restoreBootTimeoutMs`) keeps a
session that never reports — or dies mid-resume — from holding up the rest.
