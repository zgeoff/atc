# Daemon architecture

The target process model: a per-user daemon owns the sessions; thin clients attach over the
[wire protocol](./protocol.md). This replaces the MVP's single process (described in
[overview](./overview.md)), where UI death is fleet death. Sequencing lives in the
[roadmap](../roadmap.md).

## Process model

```text
atc (client TUI) ──┐
atc (ssh client) ──┼── NDJSON protocol ──> atcd
                   │                        ├── PTY per session ──> claude or grok
                   │                        ├── screen model per session (@xterm/headless)
                   │                        ├── hook/statusline listener (separate socket)
                   │                        └── SQLite state
```

- One daemon per user, tmux-style auto-spawn: the first `atc` invocation boots `atcd` if the socket
  is absent, then connects. `atc daemon` exists explicitly for systemd or debugging.
- Clients are disposable. A client crash or terminal close costs nothing; the daemon detaches its
  subscriptions and the fleet runs on. Fleet restore remains only as cold-boot recovery after daemon
  death.
- Each client has its own focused session; a session streams to every attached client. Per-client
  focus is a subscription (`session.attach`/`detach`) — an unfocused session costs a client zero
  bytes.

## The two listeners

The daemon runs two socket listeners with different peers and different dialects, and they stay
separate:

- The client protocol socket ([protocol](./protocol.md)): long-lived connections, handshake,
  request/response/event envelope.
- The reporter socket: the existing one-line NDJSON dialect spoken by `hook-report` and
  `statusline`, short-lived processes spawned inside wrangled sessions on every hook event and
  statusline render. Forcing them through the framed protocol would mean a handshake per invocation.
  Reporter events feed the session state machine, which then emits `SessionState` /
  `PermissionRequested` protocol events to clients.

## Screen model

A headless terminal emulator per session (`@xterm/headless` + serialize addon) consumes every PTY
byte continuously — background output is consumed, not discarded. Attach-replay, backpressure
collapse-to-repaint, and multi-client fidelity all depend on it, and it is also a future _detector
input_: "is this agent waiting at a prompt?" is answerable from screen state for agents with no hook
system. Scrollback is capped aggressively (current screen plus a few hundred lines); the protocol
degrades without the emulator (jiggle-repaint fallback), so the daemon ships before the screen model
has to.

## Sessions, surfaces, adapters

- A session is the universal core — state machine (`running` / `needs_you` / `done` / `exited`),
  attention flag, identity — plus a surface that produces its output: `PtySurface` (terminal bytes,
  what exists today) or later `SdkSurface` (structured JSON messages from an Agent SDK session, no
  terminal at all). Session `kind` is carried in every descriptor and attach.
- Everything agent-specific lives in an adapter: `ClaudeAdapter` (spawn arguments, `--settings`
  instrumentation, resume semantics, transcript name-pulling, statusline chaining) and `GrokAdapter`
  (spawn arguments, resume semantics, `summary.json` name-pulling). The core never knows about a
  particular CLI. Lookup never returns a different kind than the one asked for. Config keys
  `grokBin` and `grokArgs` select the Grok binary; atc always appends `--no-leader`.
- Attention detection is a per-adapter detector stack: hooks where they exist (Claude and Grok),
  screen heuristics as the universal fallback, API signals for SDK surfaces. Grok has no headless
  handoff: overlay `H` is hidden and ignored on a Grok row, and `session.eject` is `unsupported`.
  Yank of a Grok session is `cd '…' && grok --resume <id>`, or `cd '…' && grok` when no id is
  captured.

## State

SQLite (`bun:sqlite`) in the daemon holds the restorable fleet, event log, spawn history, and
last-used agent (written on a deliberate-spawn SessionStart, advertised on `daemon.hello`) in one
store with no cross-process write races. `status.json` alone stays a plain file, because statusline
reporters in wrangled sessions read it without speaking the protocol. Grok attention is a
self-installed hook file at `$GROK_HOME/hooks/atc-reporter.json`; `atc grok-hooks` prints it.
