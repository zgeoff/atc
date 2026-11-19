<div align="center">
  <h1>atc</h1>

  <p>     <a href="https://github.com/zgeoff/atc/releases/latest"><img src="https://img.shields.io/github/v/release/zgeoff/atc" alt="latest release"></a>     <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>     <a href="./docs/README.md">Documentation</a> •     <a href="./docs/guides/using-atc.md">Using atc</a> •     <a href="./docs/guides/configuration.md">Configuration</a>
  </p>
</div>

atc is a daemon that hosts your Claude Code, Codex and Grok sessions, each in a terminal of its own.
Other agents drive the sessions over MCP, scripts message them, and you watch them in the `atc` TUI.

Any MCP client can spawn a session, read its screen and type into it. With a Claude Code session,
the client can also answer menus and read the transcript. Claude Code sessions, and Codex sessions
on an [App Server](./docs/guides/configuration/agents.md#codex-sessions-that-take-messages), take
messages and send answers back. A script sends one with
[`atc send`](./docs/guides/using-atc.md#sending-a-session-a-message-from-a-script):

```sh
# Ask a session something and print its answer.
atc send reviewer "Is the migration safe to run?" --wait

# Send from cron. A rerun with the same key sends nothing new.
atc send planner "Start the daily triage" --key "triage-$(date +%F)" --from cron
```

The TUI is one more client. One session fills the terminal, `Ctrl-Space` opens the list, and a
session that's waiting on you turns red. Quit it and the sessions keep running.

<img src="./docs/assets/demo.gif" alt="atc: spawn a session, open the session list, jump back in" width="1100">

## Install

```sh
brew install zgeoff/tap/atc
```

atc needs `claude`, `codex` or `grok` on your PATH, and Codex and Grok need
[atc's hooks](./docs/guides/using-atc.md#grok-and-codex-hooks). The
[install guide](./docs/guides/install.md) covers the other ways to install.

Run `atc` to start the daemon and open the TUI. Press `n` to spawn a session and `?` for the keys.
To give an agent the sessions as MCP tools, register the server with it:

```sh
claude mcp add --scope user atc -- atc mcp
```

## Features

- An agent in an atc session can spawn sub-sessions, which list under the top-level session and stop
  with it ([agents that drive agents](./docs/guides/using-atc.md#agents-that-drive-agents)).
- A Claude Code session can message one on another host and read the answer
  ([messages](./docs/architecture/protocol/messages.md)).
- `atc events` streams what the sessions do, `config.json` hooks run your commands on each event,
  and a subscribed MCP client gets a webhook ([events](./docs/guides/events.md),
  [MCP Events](./docs/architecture/remote/mcp-events.md)).
- The TUI lists the sessions of every daemon in your config, `atc mcp --daemon <name>` points an
  agent at one, and atc-gateway puts several behind one MCP endpoint
  ([gateway](./docs/guides/gateway.md)).
- `atc mcp` also serves over HTTP behind OAuth, for a hosted assistant such as Claude.ai
  ([remote MCP](./docs/guides/remote-mcp.md)).
- A session can run in a cloud VM through the imp provider. The VM sleeps when you stop the session
  and wakes where it left off ([targets](./docs/guides/configuration/targets.md)).
- A daemon restart or upgrade resumes every session's conversation from its transcript
  ([restarting](./docs/guides/using-atc.md#restarting-the-daemon)).

## Configuration

atc creates `~/.config/atc/config.json` on first run. The
[configuration guide](./docs/guides/configuration.md) covers each key.

## Documentation

[docs/](./docs/README.md) covers how atc works, the guides and the runbooks.
