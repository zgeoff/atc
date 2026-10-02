# Configuration

atc reads `~/.config/atc/config.json` and creates it with defaults on first run:

```json
{
  "claudeBin": "claude",
  "claudeArgs": [],
  "grokBin": "grok",
  "grokArgs": [],
  "codexBin": "codex",
  "codexArgs": [],
  "dirs": { "roots": [] },
  "gateways": {},
  "hooks": {},
  "leader": "ctrl-space"
}
```

| Field           | Default         | Meaning                                                                                                                |
| --------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `claudeBin`     | `"claude"`      | The binary spawned for Claude sessions.                                                                                |
| `claudeArgs`    | `[]`            | Prepended to every Claude spawn, e.g. `["--model", "opus"]`. A spawn's own model or effort replaces the matching flag. |
| `grokBin`       | `"grok"`        | The binary spawned for Grok sessions.                                                                                  |
| `grokArgs`      | `[]`            | Prepended to every Grok spawn. A user `--leader` in this list is dropped; atc always appends `--no-leader`.            |
| `codexBin`      | `"codex"`       | The binary spawned for Codex sessions.                                                                                 |
| `codexArgs`     | `[]`            | Prepended to every Codex spawn. A spawn's own model replaces a `-m` or `--model` here.                                 |
| `dirs`          | `{ roots: [] }` | Where the directory picker looks beyond its own history. The [directories](#directories) section covers it.            |
| `gateways`      | `{}`            | Claude-compatible backends, keyed by agent id. Each becomes its own row in the agent picker.                           |
| `hooks`         | `{}`            | Commands the daemon runs on wire events — the [events guide](./events.md#daemon-hooks) covers them.                    |
| `leader`        | `"ctrl-space"`  | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                                  |
| `targets`       | unset           | Where sessions run, keyed by target id. The [targets](#targets) section covers it.                                     |
| `defaultTarget` | unset           | The target a spawn without a target runs on.                                                                           |

## Leader

Pick a different leader when `Ctrl-Space` is taken on your machine — Raycast on macOS claims it, and
`ctrl-]` is a replacement that no common terminal, multiplexer, or OS shortcut wants. An unknown or
reserved value falls back to the default.

## Directories

The directory picker behind `n` merges its sources in a fixed order: the directory you ran `atc`
from, then atc's own spawn history (most recent first), then every project under `dirs.roots`, then
zoxide's list when zoxide is installed. A path that no longer exists is dropped, and a duplicate
keeps its first position.

```json
{
  "dirs": { "roots": ["~/projects", "~/work"] }
}
```

Each root contributes its immediate child directories and each child's `.worktrees/*` entries, so
`~/projects/atc` and `~/projects/atc/.worktrees/fix-picker` both list for a root of `~/projects`.
Hidden directories are skipped. A root that does not exist contributes nothing.

Typed input that starts with `/`, `~`, `.`, or `..` completes against the filesystem instead of
filtering the list: `~/pro` lists the directories under your home that start with `pro`, and a
trailing slash lists every child. A relative path resolves against the directory you ran `atc` from.
Hidden directories complete only when the typed segment starts with a dot.

## Targets

A target is a named place sessions run, served by an execution provider. With no `targets` key, atc
has one target, `local`, which runs each session on the daemon's own machine. Set `targets` to name
your own:

```json
{
  "targets": {
    "local": { "provider": "local-pty" },
    "box": { "provider": "imp", "image": "dev" }
  },
  "defaultTarget": "local"
}
```

- `provider` selects the provider kind. `local-pty` is the one built-in kind. Every other key in the
  entry is an option for that provider.
- A target whose provider kind this atc does not have still lists, as unavailable, and a spawn to it
  fails with `target_unavailable`.
- A `targets` map without `local` turns local sessions off: a spawn to `local` fails with
  `unknown_target`.
- A spawn without a target runs on `defaultTarget`. Without `defaultTarget`, it runs on `local` when
  the map holds it, and fails with `target_config_invalid` otherwise.

atc never runs a session on a target other than the one it was sent to. A spawn to an unknown or
unavailable target fails, and a restore lists a session whose target is gone as exited, with
`no target '<target_id>'` as its last message. Revive it after you add the target back.

A session stays bound to its target as the target stood when the session started: its provider kind
and options. Change a target's provider or options, and each session started on it refuses input,
resume, and revive with `target_changed`, listing as exited with `target '<target_id>' changed`.
Restore the target's earlier config to use those sessions again, or kill them. Never put a
credential value in a target's options; name an environment variable that holds it instead.

A target config that is set but wrong fails closed. atc keeps running, the targets it can read keep
working, and every spawn that resolves through the problem fails with `target_config_invalid`, whose
message holds the problem:

- A `targets` that is not an object, or an empty map, leaves no target usable, `local` included.
- An entry that is not an object holding a non-empty string `provider` leaves that target unusable.
- A `defaultTarget` that matches no well-formed target leaves no default, so a spawn without a
  target fails.

A `config.json` that exists but that atc cannot use fails closed for every target, `local` included.
Invalid JSON, or a root that is not an object, is `config_malformed`. A read that fails for any
reason but a missing file, such as a directory at the path or a file you cannot read, is
`config_unreadable`. atc then has no targets and no default, and every spawn, revive, and headless
turn fails with `target_config_invalid` until you fix the file and restart the daemon. Listing and
reading sessions keep working. Only a missing file means the defaults, and atc writes them out on
its first run.

The daemon prints each problem to stderr when it starts, and `agents.list` returns them as
`targetErrors`. A file problem there has `scope` `config`, with `problem`, `path`, and `detail`. A
problem or detail holds no value from the file beyond a target's name, so a mistyped field reports
its kind, never its content. To find the line that breaks invalid JSON, run the file through a
validator such as `jq . ~/.config/atc/config.json`.

## Gateways

A gateway runs the Claude CLI against a Claude-compatible backend, under its own agent id. Claude
and GLM sessions then sit side by side in one fleet:

```json
{
  "gateways": {
    "zai": {
      "label": "GLM (z.ai)",
      "mark": "z",
      "baseURL": "https://api.z.ai/api/anthropic",
      "apiKeyHelper": "~/.local/bin/atc-zai-key",
      "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2" }
    }
  }
}
```

| Field          | Default     | Meaning                                                                                                        |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `baseURL`      | required    | The backend's Anthropic-format endpoint. An entry without one is left out of the picker.                       |
| `label`        | the id      | The row shown in the agent picker.                                                                             |
| `mark`         | the id      | The overlay column letter; the first character is used.                                                        |
| `bin`, `args`  | `claudeBin` | The binary and leading arguments, when the backend needs a different build of the CLI.                         |
| `apiKeyHelper` | none        | Command the CLI runs to read the credential, so no token is written into atc's state directory.                |
| `env`          | `{}`        | Extra environment for the session, such as the model each Claude tier maps to.                                 |
| `settings`     | none        | More Claude Code settings for this gateway's sessions. The [section below](#extra-session-settings) covers it. |

A spawn through `atc_session_spawn` or `session.spawn` can pick a model and an effort per session;
the [protocol](../architecture/protocol.md#spawn-options) lists what each agent takes. A gateway
offers each tier its `env` maps as a model, and passes an effort on to the CLI, which its provider
may ignore.

The id may not be `claude`, `grok`, or `codex`. atc writes one settings file per id and passes it as
`--settings`, on the terminal spawn and on a headless turn alike, so a gateway session reaches its
own backend rather than whatever the terminal exported. Two backends may be given the same `mark`;
atc does not check, and a clash makes them indistinguishable in the overlay column.

### Extra session settings

`settings` is a Claude Code settings object folded into the generated file, so one gateway's
sessions carry hooks, permissions, or a model that no other agent gets. atc's own keys stay atc's,
and a hook list joins the fleet reporter on that event rather than replacing it.

A permission classifier is the case this exists for. Claude Code's auto mode judges nothing in a
session pointed at another backend, so a gateway session asks about every write and every command
until something else answers. A hook that answers them belongs to the gateway rather than to your
global settings:

```json
{
  "gateways": {
    "zai": {
      "baseURL": "https://api.z.ai/api/anthropic",
      "settings": {
        "hooks": {
          "PermissionRequest": [
            {
              "matcher": ".*",
              "hooks": [{ "type": "command", "command": "~/.local/bin/classify", "timeout": 90 }]
            }
          ]
        }
      }
    }
  }
}
```

Claude Code sends `PermissionRequest` only when it is about to ask you, so a hook there answers the
prompts and sees nothing the CLI already allows. Your own Claude sessions never see it: the block
belongs to this gateway id alone.

## Attention hooks (Grok and Codex)

Claude needs no install step: atc instruments each spawned Claude session through a generated
`--settings` file, and your global Claude settings are untouched. Grok and Codex take their
instrumentation from your own agent config, so it is a one-time self-install — atc prints the hooks
and never writes them.

Install the Grok hook file at `$GROK_HOME/hooks/atc-reporter.json` (`~/.grok` when `GROK_HOME` is
unset):

```sh
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json
```

`atc grok-hooks` prints the hook entries with the `hook-report` command resolved for this install. A
missing file is a Grok PTY without hook-driven attention.

Codex hooks live in `$CODEX_HOME/hooks.json` (`~/.codex` when `CODEX_HOME` is unset):

1. Run `atc codex-hooks` and merge the printed entries into `$CODEX_HOME/hooks.json`.
2. Open `codex`, review the atc hooks in its hooks list, and approve them once. Codex parses
   untrusted hooks but never runs them.

Sessions you start outside atc report events too; the reporter exits immediately when no atc session
id is present.

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
connector needs. ChatGPT returns to `https://chatgpt.com/connector_platform_oauth_redirect`, and
Claude returns to `https://claude.ai/api/mcp/auth_callback` or
`https://claude.com/api/mcp/auth_callback`. [Remote MCP](../architecture/remote-mcp.md#clients)
covers clients, the approval flow, and the checks.

## State locations

Daemon state lives in `~/.local/state/atc/` — the
[architecture overview](../architecture/overview.md#state) covers the files. The daemon's sockets
and pid file sit in `$XDG_RUNTIME_DIR`, and `daemon.json` in the state directory holds their paths
for a client whose environment lacks that variable.
