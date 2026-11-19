<div align="center">
  <h1>atc</h1>

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

atc is a daemon that runs your Claude Code, Codex and Grok sessions, so other agents, scripts and
you can drive them.

Any MCP client can spawn a session, read its screen, type into it, pick from its menus, and send it
a message and get the answer back. `atc send` does the messaging part from a shell script, cron, CI
or a systemd unit:

```sh
# Ask a session something and print its answer.
atc send reviewer "Is the migration safe to run?" --wait

# Queue a job from cron. The key makes a retry send once.
atc send planner "Start the daily triage" --key "triage-$(date +%F)" --from cron
```

The `atc` TUI is one more client. One session fills the terminal, `Ctrl-Space` opens the list, and a
session that's waiting on you turns red. Quit it and the sessions keep running.

<img src="./docs/assets/demo.gif" alt="atc: spawn a session, open the session list, jump back in" width="1100">

## Install

```sh
brew install zgeoff/tap/atc
```

atc needs `claude`, `codex` or `grok` on your PATH. Codex and Grok take a
[one-time hook install](./docs/guides/using-atc.md#grok-and-codex-hooks). The
[install guide](./docs/guides/install.md) covers the other ways to install.

Run `atc` to start the daemon and open the TUI. Press `n` to spawn a session and `?` for the keys.
To give an agent the fleet, register the MCP server with it:

```sh
claude mcp add --scope user atc -- atc mcp
```

## Features

- **Agents that drive agents.** A session an agent spawns through `atc mcp` lists under it and ends
  with it ([agents that drive agents](./docs/guides/using-atc.md#agents-that-drive-agents)).
- **Messages with answers.** Claude Code sessions take messages from this host or another and answer
  them, and so do Codex sessions on an App Server
  ([messages](./docs/architecture/protocol/messages.md)).
- **Events.** `atc events` prints what the fleet does, hooks run your commands on it, and a webhook
  wakes a subscribed MCP client ([events](./docs/guides/events.md),
  [MCP Events](./docs/architecture/remote/mcp-events.md)).
- **One fleet across hosts.** The TUI lists every configured daemon's sessions,
  `atc mcp --daemon <name>` points an agent at one, and atc-gateway serves several through one
  connector ([gateway](./docs/guides/gateway.md)).
- **Hosted assistants.** `atc mcp --http` serves the tools behind OAuth, with the scopes you approve
  ([remote MCP](./docs/guides/remote-mcp.md)).
- **Cloud VMs.** A session can run in its own imp VM, which sleeps when you stop it and wakes where
  it left off ([targets](./docs/guides/configuration/targets.md)).
- **Sessions survive restarts.** A daemon restart, or an upgrade with `u`, brings every session back
  from its transcript ([restarting](./docs/guides/using-atc.md#restarting-the-daemon)).

## Configuration

atc creates `~/.config/atc/config.json` on first run. The
[configuration guide](./docs/guides/configuration.md) covers each key.

## Documentation

[docs/](./docs/README.md) covers how atc works, the guides and the runbooks.
