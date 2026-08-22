# Architecture overview

atc multiplexes Claude Code, Grok Build, and Codex CLI sessions without a tiling layout engine: one
focused session owns the whole terminal, and everything else is reached through a keyboard-driven
overlay. The design bet is that the pain of many-session work is attention routing, not window
management. `n` and `r` open an agent picker first; last-used comes from `daemon.hello` and is
written on SessionStart of a deliberate spawn. A fleet restore does not stamp it. MCP spawn ignores
last-used and defaults to Claude. The picker resolves each agent's configured binary as it opens and
lists only the ones that resolve, so every row is a session that can start — an uninstalled agent
would otherwise show up three steps later as a PTY that dies on exec. An uninstalled last-used agent
gives up the opening selection to the first installed one, and a menu with no rows at all carries
the config keys to set.

A session records which agent it runs under as an id, and the daemon keys its adapter registry by
that id. A configured gateway is an id of its own: the Claude CLI against a Claude-compatible
backend, with its own picker row, its own generated settings file, and its own fleet rows. That
settings file is passed to the terminal spawn and to a headless turn alike, so ejecting a gateway
session keeps it on its backend. A fleet row whose id has no registered adapter keeps its place and
refuses to revive, so a backend dropped from the config never comes back as Claude.

## Process model

```text
atc (client TUI) ── NDJSON protocol ──> atcd (atc daemon)
                                         ├── PTY per session ──> claude --settings <generated>
                                         │                    or grok --no-leader, or codex
                                         ├── reporter socket (hook + statusline reports)
                                         └── SQLite state in ~/.local/state/atc/
```

- The daemon owns the sessions; the first `atc` invocation boots it if its socket is absent, then
  connects as a thin client speaking the [wire protocol](./protocol.md). Clients are disposable —
  quitting or crashing one leaves the fleet running. See the [daemon architecture](./daemon.md).
- Each session is a `claude`, `grok`, or `codex` child process on its own PTY (`bun-pty`) inside the
  daemon. Attached clients receive the session's output as sequenced events; a slow client desyncs
  and resynchronizes rather than stalling the PTY or other clients.
- A per-session vt state machine (`@xterm/headless`) consumes every PTY byte continuously, so
  attaching is an instant serialized-screen replay — no resize jiggle, no reliance on the hosted
  agent repainting itself.
- `src/sessions.ts` is the state machine: session states are `running`, `needs_you`, `done`,
  `exited`, each with an `unread` attention flag.

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

Grok sessions use a dedicated hook file at `$GROK_HOME/hooks/atc-reporter.json` (`~/.grok` when
`GROK_HOME` is unset). atc never writes that path; `atc grok-hooks` prints the file to install. The
same reporter forwards Grok camelCase envelopes. Config keys `grokBin` and `grokArgs` select the
binary; atc always appends `--no-leader`. Grok names come from `summary.json`. Yank of a Grok
session pastes `cd '…' && grok --resume <id>`, or `cd '…' && grok` when no id is captured. Headless
eject (`H`) is Claude-only; a Grok row hides and ignores it.

## State

All in `~/.local/state/atc/`:

| File          | Purpose                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atc.db`      | SQLite: the restorable fleet (rewritten on deliberate kills only; killed sessions persist as exited entries), the hook-event trail, the spawn-directory history for the picker, and last-used agent (written on a deliberate-spawn SessionStart, advertised on `daemon.hello`). |
| `status.json` | Counts + most urgent session, read by the injected statusline on each render — a plain file because reporters read it without speaking the protocol.                                                                                                                            |

The daemon's pid file (`atc-daemon.pid`) lives beside its sockets in `$XDG_RUNTIME_DIR`, not in the
state directory: a pid is only meaningful for the daemon owning those sockets, and a shared location
would let one runtime's stale-daemon restart kill another runtime's healthy daemon.

## Recovery model

A client crash costs nothing — the daemon keeps hosting the fleet. If the daemon itself dies, its
children die with it (PTY close → SIGHUP), but each agent streams transcripts to disk continuously,
so sessions are data, not processes. Restore reconstructs each row with the matching CLI
(`claude --resume <id>`, `grok --resume <id>`, or `codex resume <id>`); the fleet table makes that a
single keypress (`R`) after a cold boot. The same mechanism powers adopt (`r`) and yank/eject
(`y`/`Y`). `H` is unsupported for Grok.

Reviving a whole fleet is incremental but visible from the start. Every fleet entry registers as a
session without a terminal before any process boots — each broadcasts `session.added`, so clients
list the full incoming fleet immediately, marked "waiting to restore". Terminals then attach one at
a time in recency order (latest hook event in the trail first, from the events table): the first
attaches at once so the caller can attach, and each later one waits for the previous session to
report its `SessionStart` hook, so an update-triggered restart does not boot a dozen agent processes
in the same instant and stall the machine. A per-session cap (`restoreBootTimeoutMs`) keeps a
session that never reports — or dies mid-resume — from holding up the rest.
