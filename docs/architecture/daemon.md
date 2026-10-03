# Daemon architecture

A per-user daemon owns the sessions; thin clients attach over the [wire protocol](./protocol.md).
The first `atc` invocation boots the daemon if its socket is absent, then connects — tmux-style
auto-spawn. `atc daemon` runs it in the foreground for systemd or debugging.

## One daemon per state directory

A daemon takes an exclusive lock on `daemon.lock` in its state directory before it opens `atc.db`,
binds a socket, or restores a session. The lock is a kernel `flock`, so two daemons started in the
same instant cannot both take it, and it dies with its process, so a crashed daemon never blocks the
next one. A daemon that finds the lock held waits two seconds for a daemon that is shutting down,
then exits with status 1 and a message holding the holder's pid and socket. The lock file is never
removed; removing it would let a newcomer lock a fresh file while the old daemon still holds the
removed one.

The lock follows the state directory, not the sockets. Socket paths come from `$XDG_RUNTIME_DIR`,
and a process whose environment lacks it, such as `atc mcp` under the Codex sandbox, computes socket
paths under the state directory instead. Once it holds the lock, the daemon writes `daemon.json`
beside it: its pid and the paths of its three sockets. A client that finds no daemon at its own
socket path reads that record and connects to the socket it holds before it boots a daemon.
Overlapping boots in one process share one spawn, and the TUI's `u` restart joins a restart that is
already running, with `⟳ restarting daemon` in the status bar until it finishes.

Clients are disposable. A client crash or terminal close costs nothing; the daemon detaches its
subscriptions and the fleet runs on. Each client has its own focused session, and a session streams
to every attached client. Per-client focus is a subscription (`session.attach`/`detach`) — an
unfocused session costs a client zero bytes.

## The three listeners

The daemon runs three socket listeners with different peers and different dialects, and they stay
separate:

- The client protocol socket ([protocol](./protocol.md)): long-lived connections, handshake,
  request/response/event envelope.
- The reporter socket: a one-line NDJSON dialect spoken by `hook-report`, `statusline`, and
  `report`, short-lived processes spawned inside wrangled sessions on every hook event, statusline
  render, and message report. Forcing them through the framed protocol would mean a handshake per
  invocation. Hook and statusline reports feed the session state machine, which then emits
  `SessionState` / `PermissionRequested` protocol events to clients. Message reports update the
  [inbox](./protocol.md#messages), which emits `SessionMessage`.
- The [events socket](./protocol.md#events-socket): a read-only broadcast stream for outside
  subscribers, with no handshake and no requests.

## User hooks

Every broadcast event also fires the user's configured hooks: the daemon runs each matching command
with the event's JSON on stdin, exactly the line clients receive — the
[events guide](../guides/events.md#daemon-hooks) covers configuration and semantics. Hooks are
observational and fire-and-forget, so a broken hook can neither gate an event nor slow an attach.
`SessionOutput` never reaches hooks — it is attach-scoped screen bytes, not fleet state.

## Screen model

A headless terminal emulator per session (`@xterm/headless` + serialize addon) consumes every PTY
byte continuously — background output is consumed, not discarded. Attach-replay, backpressure
collapse-to-repaint, and multi-client fidelity all depend on it, and it is also a detector input:
"is this agent waiting at a prompt?" is answerable from screen state for agents with no hook system.
Scrollback is capped aggressively (current screen plus a few hundred lines).

## Sessions and adapters

- A session is the universal core — state machine (`running` / `needs_you` / `done` / `exited`),
  attention flag, identity — plus a `kind`: `pty` (terminal bytes) or `headless` (structured
  messages from an Agent SDK run, no terminal at all). The kind is carried in every descriptor and
  attach.
- Everything agent-specific lives in an adapter implementing `AgentAdapter`: spawn arguments,
  instrumentation, resume semantics, and name-pulling for Claude, Grok, Codex, and each configured
  gateway. The core never knows about a particular CLI, and lookup never returns a different kind
  than the one asked for.
- Attention detection is a per-adapter detector stack: hooks where they exist, screen heuristics as
  the universal fallback.

## State

SQLite (`bun:sqlite`) in the daemon holds the fleet, event trail, spawn history, and last-used agent
in one store with no cross-process write races; the [overview](./overview.md#state) covers the
files. `status.json` alone stays a plain file, because statusline reporters in wrangled sessions
read it without speaking the protocol.

The fleet table keys each row by the atc session id. The agent session id is optional, since a row
exists from the moment a session spawns, and unique, since one agent session belongs to one row.
When a resume gives a second session the same agent session id, the row written last replaces the
earlier one. The write then relinks the rows it keeps as a one-level hierarchy. A link to a replaced
row moves to the row that replaced it, and a row that was a sub-session of the row it replaced takes
that row's parent instead. A row linked to a row the fleet does not hold becomes top-level. Where
two crossed resumes leave rows linked in a cycle, the row written first in the cycle becomes
top-level. A row whose parent is itself a sub-session moves up to the top-level row above it. No row
is its own parent, and every parent is a top-level row the fleet holds.

The `session_owner` table records which daemon owns each fleet row, by the `daemonID` the store
holds in `prefs`, and at which ownership epoch. A fleet write deletes and rewrites only the rows
this daemon owns, and a restore loads only those rows. A write that touches a session another daemon
owns, or one whose stored epoch is past this daemon's, fails whole with `stale_epoch`. Every row
this daemon writes holds epoch 1.
