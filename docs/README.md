# atc documentation

Architecture and guides for atc, the terminal control tower for coding-agent sessions. The
[root README](../README.md) covers install, keys, and everyday use.

## Architecture

- [Overview](./architecture/overview.md) — what atc is, the process model, agents and gateways, the
  integration contract, state files, and the recovery model.
- [Daemon](./architecture/daemon.md) — the daemon's internals: listeners, user hooks, the screen
  model, sessions and adapters.
- [Protocol](./architecture/protocol.md) — the daemon/client wire protocol: NDJSON envelope, methods
  and events, the events socket, streaming, backpressure, permissions.

## Guides

- [Configuration](./guides/configuration.md) — every `config.json` field: per-agent binaries, the
  leader key, gateways, and the Grok/Codex attention-hook install.
- [Events](./guides/events.md) — consuming fleet events: daemon hooks, `atc events`, and the
  read-only events socket.
