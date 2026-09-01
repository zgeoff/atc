# Daemon architecture

A per-user daemon owns the sessions; thin clients attach over the [wire protocol](./protocol.md).
The first `atc` invocation boots the daemon if its socket is absent, then connects — tmux-style
auto-spawn. `atc daemon` runs it in the foreground for systemd or debugging.

Clients are disposable. A client crash or terminal close costs nothing; the daemon detaches its
subscriptions and the fleet runs on. Each client has its own focused session, and a session streams
to every attached client. Per-client focus is a subscription (`session.attach`/`detach`) — an
unfocused session costs a client zero bytes.

## The three listeners

The daemon runs three socket listeners with different peers and different dialects, and they stay
separate:

- The client protocol socket ([protocol](./protocol.md)): long-lived connections, handshake,
  request/response/event envelope.
- The reporter socket: a one-line NDJSON dialect spoken by `hook-report` and `statusline`,
  short-lived processes spawned inside wrangled sessions on every hook event and statusline render.
  Forcing them through the framed protocol would mean a handshake per invocation. Reporter events
  feed the session state machine, which then emits `SessionState` / `PermissionRequested` protocol
  events to clients.
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
