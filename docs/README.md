<div align="center">
  <h1>atc documentation</h1>

  <p>How atc works, how to use it, and how to develop and release it.</p>

  <p>
    <a href="./architecture/overview.md">Architecture</a> •
    <a href="#guides">Guides</a> •
    <a href="#runbooks">Runbooks</a> •
    <a href="../AGENTS.md">Agent Guidelines</a>
  </p>
</div>

---

## Architecture

How atc is built: the parts, what each one owns, and what holds whatever a caller does.

- [Architecture overview](architecture/overview.md) — the path of a keystroke, the topology, the
  data and the cross-cutting rules, on one page

### Daemon

- [The daemon](architecture/daemon/daemon.md) — one daemon per state directory, startup, who boots
  it, protocol mismatches, the listeners and stopping
- [Restarting the daemon](architecture/daemon/restart.md) — the restart worker, the unit path and
  the plain path, verifying the fleet, and one restart at a time
- [Sessions](architecture/daemon/sessions.md) — attention from hooks, names, the lifecycle layers,
  sub-sessions, ending a session and the headless handoff
- [Fleet and restore](architecture/daemon/fleet-and-restore.md) — the state store, the fleet rows,
  the staggered restore and what each failure costs
- [Terminals](architecture/daemon/terminals.md) — the screen model, attaching, backpressure, several
  clients on one session and submitting a line

### Protocol

- [The client protocol](architecture/protocol/protocol.md) — JSON lines, errors, the handshake,
  versions and features, events and the connection lifecycle
- [Principals](architecture/protocol/principals.md) — acting as a principal, reach, and the TCP
  listener with its bearer tokens
- [Idempotent requests](architecture/protocol/idempotency.md) — keys, unknown outcomes, recovery
  after a crash and replay-only resends
- [Messages](architecture/protocol/messages.md) — the inbox, the tap, answers by turn, notes, and
  remote sessions' outboxes
- [Events](architecture/protocol/events.md) — the consumers, the event trail and its cursors, the
  events socket and user hooks

### Agents

- [Adapters](architecture/agents/adapters.md) — the adapter interface, the registry, gateway agents,
  the agent picker and spawn options
- [Agent integration](architecture/agents/agent-integration.md) — session helpers, Claude Code's
  settings and statusline, the atc-bridge mod, and Grok and Codex hooks

### Execution

- [Execution targets](architecture/execution/targets.md) — providers and capabilities, binding to a
  target, the one check and the environment a harness gets
- [The imp provider](architecture/execution/imp-provider.md) — leases, the guest folder, the session
  bridge and reconnecting to a harness
- [Runtime auth](architecture/execution/runtime-auth.md) — broker bindings, spawn checks, admission,
  revoke and rebind
- [Workspaces](architecture/execution/workspaces.md) — sources, the materialization phases, claims
  and rollback, and the spawn picker's sources
- [Session record](architecture/execution/session-record.md) — the record's format, declaring record
  scope, delivery and who may change it

### Remote access

- [The MCP servers](architecture/remote/mcp.md) — tools and grant scopes, the stdio server, remote
  callers, reconnecting and reading notes
- [OAuth](architecture/remote/oauth.md) — the authorization server, connecting a client, grants and
  tokens, and the request checks
- [The gateway](architecture/remote/gateway.md) — the gateway binary, ids and routing across
  daemons, and lost answers

## Guides

- [Installing atc](guides/install.md) — Homebrew, the install script, npm and the environment atc
  takes
- [Using atc](guides/using-atc.md) — spawning, the session list and its keys, Grok and Codex hooks,
  agents that drive agents, and restarting the daemon
- [Configuration](guides/configuration.md) — every `config.json` field: agents, targets, gateways,
  brokered credentials, principals and hooks
- [Events](guides/events.md) — daemon hooks, `atc events` and the events socket
- [Remote MCP](guides/remote-mcp.md) — serving a hosted assistant, adding and approving clients,
  grants, and the systemd units
- [Running atc-gateway](guides/gateway.md) — the daemon listener and its tokens, the registry,
  serving and clients

## Runbooks

- [Development](runbooks/development.md) — setting up a checkout, running from source in a home of
  its own, and the test scripts
- [Releasing](runbooks/releasing.md) — the release App, the Homebrew tap, the image pin, the first
  publish and recovering a release
