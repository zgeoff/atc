<div align="center">
  <h1>atc</h1>

  <p>
    Control tower for coding-agent sessions: stock <code>claude</code>, <code>grok</code>, and
    <code>codex</code> instances in PTYs behind a keyboard-driven session list with hook-driven
    attention routing — no panes, no tiling, no mouse.
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@zgeoff/atc"><img src="https://img.shields.io/npm/v/%40zgeoff%2Fatc" alt="npm version"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>
    <a href="./docs/README.md">Documentation</a> •
    <a href="./docs/guides/configuration.md">Configuration</a> •
    <a href="./docs/architecture/overview.md">Architecture</a>
  </p>
</div>

## Install

```sh
bun add -g @zgeoff/atc
atc
```

atc needs [Bun](https://bun.sh) and the `claude` CLI on your PATH. Grok sessions need the `grok`
CLI, and Codex sessions the `codex` CLI — the agent picker lists only the agents whose binary it can
find. With [zoxide](https://github.com/ajeetdsouza/zoxide) installed, the spawn directory picker
feeds on its frecency list, so every directory you visit is two keystrokes from a session; without
it, the picker falls back to atc's own spawn history.

The first invocation auto-spawns the daemon; the TUI is a thin client, so quitting or crashing it
leaves every session running. atc runs fine nested inside zellij or tmux — give the pane locked mode
so the leader key reaches atc.

## Keys

| Key             | Where          | Action                                                                                         |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| leader          | anywhere       | toggle session overlay — `Ctrl-Space` by default, configurable                                 |
| `n`             | home/overlay   | spawn: pick agent → dir → name → optional first prompt                                         |
| `r`             | home/overlay   | adopt an existing session: pick agent → dir → name                                             |
| `R`             | home           | restore the last fleet after a daemon death                                                    |
| `j`/`k`/`↑`/`↓` | overlay/picker | move                                                                                           |
| `Enter`         | overlay        | attach (auto-acks)                                                                             |
| `Tab`           | overlay        | attach the most urgent needs-you session, else the latest turn-done one                        |
| `/`             | overlay        | fuzzy filter by name/dir, `⏎` attach top match, `esc` clear                                    |
| `a`             | overlay        | ack a notification without attaching                                                           |
| `p`             | overlay        | pin or unpin — pinned sessions stay at the top of the list                                     |
| `g`             | overlay        | toggle the grouped view: sessions cluster under repository headers                             |
| `H`             | overlay        | eject to headless — hidden on agents with no headless handoff                                  |
| `P`             | overlay        | revive: a fresh terminal resumes a headless or killed session in place                         |
| `y`             | overlay        | yank the resume command for the session's agent                                                |
| `Y`             | overlay        | eject: yank the resume command, then kill the session here                                     |
| `K`             | overlay        | kill selected (confirm with `y`) — the entry stays revivable with `P`; a second `K` forgets it |
| `u`             | overlay        | restart an outdated daemon and restore the fleet — offered while `⟳ update ready` shows        |
| `?`             | overlay        | full key reference — the hint row only shows actions valid for the selected session            |
| `q`             | home/overlay   | quit the client — sessions keep running in the daemon                                          |

The overlay orders sessions by pinned first, then attention state, then most recently attached, so
the session you want is nearly always near the top. Session states: red `●` needs you, cyan `◐`
running, green `✓` turn done, gray `✗` exited. Everything else passes through to the focused
session, which owns the full screen; while attached, atc appends a fleet segment
(`▏● 2 need you: auth-bug`) to your own Claude Code statusline.

## Attention hooks

Claude sessions report attention automatically: atc injects its hooks through a generated
`--settings` file per spawn and never touches your own Claude config. Grok and Codex hooks are a
one-time self-install — atc prints them and never writes into your agent config either:

```sh
# Grok: install the hook file
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json

# Codex: print the entries, merge them into ~/.codex/hooks.json,
# then trust them once in the codex TUI
atc codex-hooks
```

The [configuration guide](./docs/guides/configuration.md#attention-hooks-grok-and-codex) covers the
detail; [agent integration](./docs/architecture/overview.md#agent-integration) covers how the
reporting works.

## Configuration

`~/.config/atc/config.json` is created with defaults on first run. The
[configuration guide](./docs/guides/configuration.md) covers every field:

- [Agent binaries](./docs/guides/configuration.md) — the binary and prepended arguments per agent,
  e.g. `"claudeArgs": ["--model", "opus"]`.
- [Leader key](./docs/guides/configuration.md#leader) — rebind the overlay toggle when `Ctrl-Space`
  is taken on your machine.
- [Gateways](./docs/guides/configuration.md#gateways) — run the Claude CLI against Claude-compatible
  backends (GLM and friends), each as its own agent in one fleet.
- [Attention hooks](./docs/guides/configuration.md#attention-hooks-grok-and-codex) — the Grok and
  Codex self-install in detail.

## Integrations

Everything the fleet does broadcasts as a wire event — sessions added, state changes, attaches,
renames, permission requests. The [events guide](./docs/guides/events.md) covers the three ways to
consume the stream:

- [Daemon hooks](./docs/guides/events.md#daemon-hooks) — run your own commands on fleet events,
  straight from `config.json`.
- [`atc events`](./docs/guides/events.md#atc-events) — the stream on stdout, one NDJSON line per
  event; pipe it into `jq` or your own tooling.
- [The events socket](./docs/guides/events.md#the-events-socket) — a read-only unix socket any
  program can subscribe to, stable across atc upgrades.

`atc mcp` exposes the fleet as MCP tools (list, spawn, drive, read the screen, organise) to any MCP
client, wrangled sessions included:

```sh
claude mcp add --scope user atc -- atc mcp
```

## Crash safety

A client crash or closed window costs nothing: the daemon keeps hosting the fleet, and the next
`atc` reconnects. If the daemon itself dies, every session's transcript is already on disk — press
`R` and the whole fleet respawns with the matching CLI. After an update, the status bar shows
`⟳ update ready`, and `u` restarts the daemon and restores the fleet at a moment you choose. The
[recovery model](./docs/architecture/overview.md#recovery-model) covers the detail.
