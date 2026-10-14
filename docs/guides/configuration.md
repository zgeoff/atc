# Configuration

atc reads `~/.config/atc/config.json` and creates it with defaults on first run:

```json
{
  "agents": { "claude": {} },
  "dirs": { "roots": [] },
  "workspaces": {
    "githubOwner": null,
    "sources": null,
    "gitTransports": ["https", "ssh"],
    "root": null,
    "targets": {}
  },
  "hooks": {},
  "leader": "ctrl-space",
  "restoreFleetOnRestart": true
}
```

| Field                   | Default          | Meaning                                                                                                                                      |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                | `{ claude: {} }` | The agents atc offers, keyed by agent id. The [agents guide](./configuration/agents.md) covers the fields of an entry.                       |
| `dirs`                  | `{ roots: [] }`  | Where the directory picker looks beyond its own history. The [directories guide](./configuration/workspaces.md#directories) covers it.       |
| `authProfiles`          | unset            | Credential references an agent's `auth` selects from. The [brokered credentials guide](./configuration/brokered-credentials.md) covers them. |
| `hooks`                 | `{}`             | Commands the daemon runs on wire events — the [events guide](./events.md#daemon-hooks) covers them.                                          |
| `leader`                | `"ctrl-space"`   | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                                                        |
| `targets`               | unset            | Where sessions run, keyed by target id. The [targets guide](./configuration/targets.md) covers it.                                           |
| `defaultTarget`         | unset            | The target a spawn without a target runs on.                                                                                                 |
| `workspaces`            | see above        | Where workspaces come from and land. The [workspaces guide](./configuration/workspaces.md#git-transports) covers it.                         |
| `restoreFleetOnRestart` | `true`           | Whether the daemon restores the fleet by itself after a restart. The [fleet restore](#fleet-restore) section covers it.                      |

## Guides by task

This guide covers the keys that stand alone. One guide covers each other task:

- [Directories and workspaces](./configuration/workspaces.md): the directory picker's roots, the git
  transports a spawn may fetch over, and where a cloned workspace lands.
- [Targets](./configuration/targets.md): where sessions run, clone trust, and the options of an imp
  target.
- [Principals](./configuration/principals.md): which targets each remote client may use.
- [Agents and gateways](./configuration/agents.md): the `agents` map, gateways to Claude-compatible
  backends, and the migration from the old agent keys.
- [Brokered credentials](./configuration/brokered-credentials.md): the `authProfiles` that impd's
  credential broker applies.
- [Brokered gateways](./configuration/brokered-gateways.md): a gateway that signs in through the
  broker on an imp.
- [Claude subscription on imps](./configuration/claude-subscription.md): a stock Claude entry that
  signs in with a subscription token impd holds, and the config bundle it copies.
- [Tools in a Claude subscription session](./configuration/subscription-tools.md): MCP servers and
  API keys whose credentials impd holds.
- [Codex subscription on imps](./configuration/codex-subscription.md): a Codex entry that signs in
  with a ChatGPT sign-in impd holds.
- [Attention hooks](./configuration/hooks.md): the hooks Grok and Codex take from your own config.

## Leader

Pick a different leader when `Ctrl-Space` is taken on your machine — Raycast on macOS claims it, and
`ctrl-]` is a replacement that no common terminal, multiplexer, or OS shortcut wants. An unknown or
reserved value falls back to the default.

## Fleet restore

With `restoreFleetOnRestart` on, the daemon restores the stored fleet once per start, after it is
listening and only when the fleet holds sessions. A restart from an update, a crash, or a reboot
brings every session back without a keypress. Each restored terminal starts at 80x24 until the first
client attaches and resizes it. The restore is the one `Shift+R` on the home screen runs: terminals
attach one at a time in recency order, and a `Shift+R` pressed while that stagger runs joins it and
starts nothing more.

Set `restoreFleetOnRestart` to `false` to leave the stored sessions out of the list until you press
`Shift+R`.

A config that still sets `resumeInterruptedTurns` loads with a warning from `atc daemon`, and atc
ignores the key. `atc config migrate` drops it.

## Remote MCP

`atc mcp --http` reads the `mcpHTTP` section, and nothing else in atc does. Command-line flags win
over it: `--host` over `host`, `--port` over `port`, `--public-url` over `publicURL`.

```json
{
  "mcpHTTP": {
    "publicURL": "https://mcp.example.com",
    "host": "127.0.0.1",
    "port": 8414,
    "allowedHosts": []
  }
}
```

| Field          | Default     | Meaning                                                                                                                                      |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicURL`    | none        | the origin clients reach the server at; https unless the host is loopback, with no path. Without it, the origin is `http://127.0.0.1:<port>` |
| `host`         | `127.0.0.1` | the address the server binds; an address beyond loopback needs an https `publicURL`, since atc does not terminate TLS                        |
| `port`         | `8414`      | the port the server binds, from 1 to 65535                                                                                                   |
| `allowedHosts` | `[]`        | further `Host` header values to accept, for a proxy that rewrites `Host`                                                                     |

Clients are not config: add each one with `atc clients add`, which prints the client ID the
connector needs, and the [principals](./configuration/principals.md) key matches. ChatGPT returns to
`https://chatgpt.com/connector_platform_oauth_redirect`, and Claude returns to
`https://claude.ai/api/mcp/auth_callback` or `https://claude.com/api/mcp/auth_callback`.
[Remote MCP](./remote-mcp.md#adding-a-client) covers clients, the approval flow, and the checks.

## State locations

Daemon state lives in `~/.local/state/atc/` — the
[architecture overview](../architecture/overview.md#data) covers the files. The daemon's sockets and
pid file sit in `$XDG_RUNTIME_DIR`, and `daemon.json` in the state directory holds their paths for a
client whose environment lacks that variable.

## Environment

atc takes its environment from the process that starts it: a shell, a systemd unit, or an MCP client
entry. A release binary never reads a `.env` file, so a `~/.env` line does not reach the daemon or
the sessions it starts. A variable that the starting process exports reaches atc, a stale one
included. Run from source with `bun packages/app/src/cli.ts`, atc follows Bun's runtime default and
loads a `.env` file from its working directory.
