<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/atc-dark.png">
    <img src="./docs/assets/atc-light.png" alt="atc" width="256">
  </picture>

  <p>
    <a href="https://github.com/zgeoff/atc/releases/latest"><img src="https://img.shields.io/github/v/release/zgeoff/atc" alt="latest release"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>
    <a href="./docs/README.md">Documentation</a> •
    <a href="./docs/guides/using-atc.md">Using atc</a> •
    <a href="./docs/guides/configuration.md">Configuration</a>
  </p>
</div>

**atc** lets you run several coding agents at once in a single terminal pane and keep track of which
are waiting on you.

`claude`, `grok`, and `codex` sessions all run in a background daemon, with a session list in front
of them. There are no panes. One session fills the terminal, `Ctrl-Space` opens the list, a session
that needs an answer turns red, and `Tab` takes you to it. Quit atc and the sessions keep running.

<img src="./docs/assets/demo.gif" alt="atc: spawn a session, open the session list, jump back in" width="1100">

## Install

```sh
brew install zgeoff/tap/atc
```

atc needs at least one of the `claude`, `grok`, or `codex` CLIs on your PATH. The
[install guide](./docs/guides/install.md) covers the install script and the prebuilt binaries for
macOS and Linux. atc ships only as binaries; the npm package is deprecated.

Then run `atc`. The first run starts the daemon. Press `n` to spawn a session, `Ctrl-Space` to see
the rest, and `?` for every other key.

## Supported agents

- **Claude Code** reports its state on its own, through a settings file atc passes at spawn, and
  takes messages from other tools.
- **Grok Build** and **Codex CLI** take a one-time hook install that atc prints for you
  ([Grok and Codex hooks](./docs/guides/using-atc.md#grok-and-codex-hooks)).
- **A Claude-compatible backend** runs as its own agent in the same fleet
  ([gateways](./docs/guides/configuration.md#gateways)).

## Features

- **Attention routing.** Sessions that need you sort to the top, and a Claude session's statusline
  shows who's waiting ([using atc](./docs/guides/using-atc.md)).
- **Sessions outlive the daemon.** A restart, or an upgrade with `u`, brings every session back from
  its transcript ([restarting](./docs/guides/using-atc.md#restarting-the-daemon)).
- **Agents that drive agents.** `atc mcp` hands any agent the fleet as MCP tools, so it can spawn,
  read, and message other sessions
  ([agents that drive agents](./docs/guides/using-atc.md#agents-that-drive-agents)).
- **Hosted assistants.** `atc mcp --http` serves the same tools to ChatGPT or Claude.ai behind
  OAuth, with the scopes you approve ([remote MCP](./docs/guides/remote-mcp.md)).
- **Several machines.** atc-gateway serves the fleets of several daemons through one connector
  ([gateway](./docs/guides/gateway.md)).
- **Sessions on imps.** A session can run in its own VM, sleeping when you kill it and waking where
  it left off ([targets](./docs/guides/configuration.md#targets)).
- **Event stream.** `atc events` prints every fleet event, and `config.json` hooks run your own
  commands on them ([events](./docs/guides/events.md)).

## Configuration

atc creates `~/.config/atc/config.json` on first run. The
[configuration guide](./docs/guides/configuration.md) covers every field: the agents and their
arguments, the leader key, targets, gateways, principals, and hooks.

## Documentation

[docs/](./docs/README.md) covers how atc works, the guides, and the runbooks.
