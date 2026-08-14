# Architecture overview

atc multiplexes Claude Code sessions without a tiling layout engine: one focused session owns the
whole terminal, and everything else is reached through a keyboard-driven overlay. The design bet is
that the pain of many-session work is attention routing, not window management.

## Process model

```text
atc (client TUI) ── NDJSON protocol ──> atcd (atc daemon)
                                         ├── PTY per session ──> claude --settings <generated>
                                         ├── reporter socket (hook + statusline reports)
                                         └── SQLite state in ~/.local/state/atc/
```

- The daemon owns the sessions; the first `atc` invocation boots it if its socket is absent, then
  connects as a thin client speaking the [wire protocol](./protocol.md). Clients are disposable —
  quitting or crashing one leaves the fleet running. See the [daemon architecture](./daemon.md).
- Each session is a `claude` child process on its own PTY (`bun-pty`) inside the daemon. Attached
  clients receive the session's output as sequenced events; a slow client desyncs and resynchronizes
  rather than stalling the PTY or other clients.
- A per-session vt state machine (`@xterm/headless`) consumes every PTY byte continuously, so
  attaching is an instant serialized-screen replay — no resize jiggle, no reliance on the hosted
  agent repainting itself.
- `src/sessions.ts` is the state machine: session states are `running`, `needs_you`, `done`,
  `exited`, each with an `unread` attention flag.

## Claude integration

Sessions are instrumented via a generated settings file passed as `claude --settings`:

- Hooks (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) run
  `atc hook-report`, which forwards the event JSON to atc's unix socket. `SessionStart` carries the
  Claude session id at spawn/resume time, which is what makes the fleet restorable before any
  interaction.
- The statusline command (`atc statusline`) chains the user's own configured statusline, then
  appends the fleet segment read from `status.json`, so fleet state renders inside Claude Code's own
  status line while attached. Its stdin JSON is also heartbeated to the socket as a second
  id-capture path.
- Session names are pulled from Claude's transcripts (`custom-title` lines from `/rename`, `summary`
  lines as fallback) — atc is not the naming authority.

## State

All in `~/.local/state/atc/`:

| File          | Purpose                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atc.db`      | SQLite: the restorable fleet (rewritten on deliberate kills only), the hook-event trail, and the spawn-directory history for the picker.             |
| `status.json` | Counts + most urgent session, read by the injected statusline on each render — a plain file because reporters read it without speaking the protocol. |

The daemon's pid file (`atc-daemon.pid`) lives beside its sockets in `$XDG_RUNTIME_DIR`, not in the
state directory: a pid is only meaningful for the daemon owning those sockets, and a shared location
would let one runtime's stale-daemon restart kill another runtime's healthy daemon.

## Recovery model

A client crash costs nothing — the daemon keeps hosting the fleet. If the daemon itself dies, its
children die with it (PTY close → SIGHUP), but Claude streams transcripts to disk continuously, so
sessions are data, not processes. `claude --resume <id>` reconstructs any of them; the fleet table
makes that a single keypress (`R`) after a cold boot. The same mechanism powers adopt (`r`) and
yank/eject (`y`/`Y`).

Reviving a whole fleet is incremental but visible from the start. Every fleet entry registers as a
session without a terminal before any process boots — each broadcasts `session.added`, so clients
list the full incoming fleet immediately, marked "waiting to restore". Terminals then attach one at
a time in recency order (latest hook event in the trail first, from the events table): the first
attaches at once so the caller can attach, and each later one waits for the previous session to
report its `SessionStart` hook, so an update-triggered restart does not boot a dozen Claude
processes in the same instant and stall the machine. A per-session cap (`restoreBootTimeoutMs`)
keeps a session that never reports — or dies mid-resume — from holding up the rest.
