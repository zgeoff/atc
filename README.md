<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/atc-dark.png">
    <img src="./docs/assets/atc-light.png" alt="atc" width="256">
  </picture>

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

<img src="./docs/assets/demo.gif" alt="atc: spawn a session, open the session list, jump back in" width="1100">

Run several coding agents at once and know which one is waiting on you.

atc keeps `claude`, `grok`, and `codex` sessions running in a background daemon and puts a session
list in front of them. There are no panes. One session fills the terminal, `Ctrl-Space` opens the
list, a session that needs an answer turns red, and `Tab` takes you to it. Quit atc and the sessions
keep running.

## Install

```sh
bun add -g @zgeoff/atc
```

atc needs [Bun](https://bun.sh) and at least one of the `claude`, `grok`, or `codex` CLIs on your
PATH. The agent picker lists the ones it finds.

## Use

```sh
atc
```

The first run starts the daemon. Press `n` to spawn a session: pick an agent, pick a directory, give
it a name, and type a first prompt if you have one. The session takes the whole screen and you work
in it as you would in a plain terminal.

`Ctrl-Space` opens the session list over whatever you are attached to. Each row carries a state
mark:

| Mark | State                                 |
| ---- | ------------------------------------- |
| `●`  | needs you: a prompt or question waits |
| `◐`  | running                               |
| `✓`  | turn done                             |
| `✗`  | exited                                |

Sessions that need you sort to the top, so the one you want is nearly always first.

| Key          | Action                                       |
| ------------ | -------------------------------------------- |
| `Ctrl-Space` | open or close the list                       |
| `Tab`        | attach the session that needs you most       |
| `Enter`      | attach the selected session                  |
| `/`          | filter by name or directory                  |
| `a`          | acknowledge a notification without attaching |
| `K`          | kill the selected session                    |
| `q`          | quit the client; sessions keep running       |
| `?`          | every other key                              |

The directory picker reads your [zoxide](https://github.com/ajeetdsouza/zoxide) list when zoxide is
installed, and atc's own spawn history otherwise. Inside a Claude session your statusline gains a
fleet segment, so `● 2 need you: auth-bug` is visible without opening the list.

If the daemon dies, press `R` on the home screen and every session respawns from its transcript.
After you upgrade atc, the status bar shows `⟳ update ready`, and `u` restarts the daemon and
restores the fleet when you are ready.

atc runs inside zellij or tmux. Give the pane locked mode so the leader key reaches atc.

## Grok and Codex

Claude sessions report attention on their own: atc passes a generated settings file at spawn time
and never edits your Claude config. Grok and Codex take a one-time hook install. atc prints the
hooks and leaves the install to you:

```sh
# Grok
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json

# Codex: merge the output into ~/.codex/hooks.json, then trust it once in the codex TUI
atc codex-hooks
```

The [configuration guide](./docs/guides/configuration.md#attention-hooks-grok-and-codex) covers both
installs in detail.

## Beyond the keyboard

- `atc mcp` exposes the fleet as MCP tools, so an agent can spawn, drive, and read other agents. A
  session spawned this way lists under the session that spawned it and is killed with it. Register
  it with `claude mcp add --scope user atc -- atc mcp`.
- `atc events` prints every fleet event as one NDJSON line. The same stream is on a unix socket, and
  `config.json` hooks run your own commands on events. The [events guide](./docs/guides/events.md)
  covers all three.
- A Claude-compatible backend runs as its own agent in the same fleet. The
  [gateways](./docs/guides/configuration.md#gateways) section covers the setup.

## Configuration

atc creates `~/.config/atc/config.json` on first run. The
[configuration guide](./docs/guides/configuration.md) covers every field: agent binaries and
arguments, the leader key, gateways, and hooks.

## Documentation

[docs/](./docs/README.md) covers the architecture, the daemon, and the wire protocol.
