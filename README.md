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

<img src="./docs/assets/demo.gif" alt="atc: spawn a session, open the session list, jump back in" width="1100">

atc runs your coding agents in a daemon, on as many machines as you like. You drive them from the
TUI, your scripts drive them from the shell, and the agents drive each other over MCP.

## What that looks like

Give an agent the whole fleet, or another machine's:

```sh
claude mcp add --scope user atc -- atc mcp
claude mcp add --scope user atc-box -- atc mcp --daemon box
```

Then ask it:

> spawn a reviewer on each open PR, and message me when they're all done

Message a session from anywhere a shell runs:

```sh
atc send reviewer "Is the migration safe to run?" --wait
git log -1 --format=%B | atc send reviewer - --key "commit-$(git rev-parse HEAD)"
atc send planner "Start the daily triage" --key "triage-$(date +%F)" --from cron
```

Watch the fleet and react. This one pings your phone when an agent needs you:

```sh
atc events |
  jq --unbuffered -r 'select(.ev == "SessionState" and .session.state == "needs_you") | .session.name' |
  while read -r name; do ntfy publish me "$name is waiting on you"; done
```

And this one hands work down the line when a session finishes:

```sh
atc events |
  jq --unbuffered -r 'select(.ev == "SessionState" and .session.name == "builder" and .session.state == "done") | .session.name' |
  while read -r _; do atc send reviewer "builder is done, review its PR"; done
```

Or skip the CLI. The events socket is plain NDJSON, with no handshake:

```sh
socat - UNIX-CONNECT:"$XDG_RUNTIME_DIR/atc-events.sock" | jq .
```

Everything else the TUI and the MCP server do goes through one typed API: the daemon's oRPC
contract, published as [`@atcx/contract`](./packages/contract/README.md).

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

- A Claude Code session can message one on another host and read the answer
  ([messages](./docs/architecture/protocol/messages.md)).
- `atc mcp` also serves over HTTP behind OAuth, for a hosted assistant such as Claude.ai
  ([remote MCP](./docs/guides/remote-mcp.md)).
- A session can run in a cloud VM through the imp provider. The VM sleeps when you stop the session
  and wakes where it left off ([targets](./docs/guides/configuration/targets.md)).
- `atc --daemon box` opens another machine's fleet, and `atc` lists every daemon in your config in
  one place ([gateway](./docs/guides/gateway.md)).
- A daemon restart or upgrade resumes every session's conversation from its transcript
  ([restarting](./docs/guides/using-atc.md#restarting-the-daemon)).

## Documentation

atc creates `~/.config/atc/config.json` on first run, and the
[configuration guide](./docs/guides/configuration.md) covers each key. [docs/](./docs/README.md)
covers how atc works, the guides and the runbooks.
