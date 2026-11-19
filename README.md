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

<img src="./docs/assets/demo.gif" alt="atc: one session list over a local and a cloud daemon, an orchestrator that starts two builders under it, and a builder that needs you" width="1100">

atc runs your coding agents in a daemon, on as many machines as you like. The TUI is a multiplexer
over all of them, your scripts drive them from the shell, and the agents drive each other over MCP.

## Usage

Give an agent the whole fleet, or another machine's:

```sh
claude mcp add --scope user atc -- atc mcp
claude mcp add --scope user atc-box -- atc mcp --daemon box
```

Then ask it:

> start a builder on the cloud box for each issue in this milestone, merge each PR once CI is green
> and its review is clean, and tell me only when one needs a decision

Each builder is a session in your TUI, so you can jump into any of them.

Message a session from anywhere a shell runs:

```sh
atc send reviewer "Is the migration safe to run?" --wait
```

Ping your phone when an agent needs you:

```sh
atc events |
  jq --unbuffered -r 'select(.ev == "SessionState" and .session.state == "needs_you") | .session.name' |
  while read -r name; do ntfy publish me "$name is waiting on you"; done
```

## Install

```sh
brew install zgeoff/tap/atc
```

atc needs `claude`, `codex` or `grok` on your PATH, and Codex and Grok need
[atc's hooks](./docs/guides/using-atc.md#grok-and-codex-hooks). The
[install guide](./docs/guides/install.md) covers the other ways to install.

Run `atc` to start the daemon and open the TUI. Press `n` to spawn a session, `Ctrl-Space` for the
list, and `?` for the keys. Quit the TUI and the sessions keep running.

## Features

- Restart or upgrade the daemon, and every session picks up where it was.
- Run sessions in [cloud VMs](./docs/guides/configuration/targets.md) that sleep when you stop them
  and wake where they left off.
- Every machine's sessions show up in [one list](./docs/guides/gateway.md).
- Serve the fleet over [HTTP behind OAuth](./docs/guides/remote-mcp.md), so a hosted assistant can
  drive it too.

## Documentation

atc creates `~/.config/atc/config.json` on first run, and the
[configuration guide](./docs/guides/configuration.md) covers each key. [docs/](./docs/README.md)
covers how atc works, the guides and the runbooks.
