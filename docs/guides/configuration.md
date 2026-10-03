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
  "workspaces": { "githubOwner": null, "sources": null, "gitTransports": ["https", "ssh"] },
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
| `workspaces`    | see above       | Where workspaces come from. The [git transports](#git-transports) section covers `gitTransports`.                      |

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

## Git transports

A spawn whose workspace is a git repository fetches it on the daemon's host.
`workspaces.gitTransports` holds the git transports that fetch may use, and defaults to
`["https", "ssh"]`; the scp-style `user@host:path` counts as `ssh`. A URL on any other transport
fails as `invalid_git_url` before git runs, and every git command the daemon runs is held to the
same list, so a host `insteadOf` rewrite, a checkout's origin, or a submodule cannot reach another
transport.

```json
{
  "workspaces": { "gitTransports": ["https", "ssh", "file"] }
}
```

The list accepts `https` and `ssh`, plus two opt-ins, `http` and `file`. This is trusted-operator
configuration, and it comes only from this file: no request, source, or environment variable widens
it. Each opt-in widens what the daemon fetches on behalf of any client that can spawn a session.
`http` sends repository contents and any credentials unencrypted. `file` lets a git source read any
repository on the daemon's host that the daemon's user can read. An empty list is valid and allows
no transport, so every git source fails.

Any other name is a config error, `git`, `ext`, `fd`, and remote-helper names among them, as is a
value that is not a list. The daemon prints the error at startup and runs no git until you fix it:
probing a repository, and spawning a workspace from a repository or from a checkout, fail as
`git_transports_invalid` with the same error. Sessions that need no git, such as one in a local
directory, start as usual.

A first run writes the default list into config.json. A config that lists the transports keeps its
list, so a later change to atc's default does not reach it.

## Targets

A target is a named place sessions run, served by an execution provider. With no `targets` key, atc
has one target, `local`, which runs each session on the daemon's own machine. Set `targets` to name
your own:

```json
{
  "targets": {
    "local": { "provider": "local-pty" },
    "box": { "provider": "imp", "url": "http://impd.tail:7070", "tokenEnv": "IMP_TOKEN" }
  },
  "defaultTarget": "local"
}
```

- `provider` selects the provider kind: `local-pty` or `imp`. Every other key in the entry is an
  option for that provider.
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
credential value in a target's options; name an environment variable or a file that holds it
instead.

### imp targets

An `imp` target runs each top-level session in an imp of its own, a VM that impd hosts, and keeps
each sub-session in its parent's imp. A kill of the top-level session puts its imp to sleep, and
`session.forget` destroys it. The [daemon architecture](../architecture/daemon.md#the-imp-provider)
covers the lifecycle. Its options:

| Key         | Default    | What it does                                                               |
| ----------- | ---------- | -------------------------------------------------------------------------- |
| `url`       | required   | Where impd listens. Without it the target lists as unavailable.            |
| `tokenEnv`  | unset      | The environment variable of the daemon that holds the impd token.          |
| `tokenFile` | unset      | The file that holds the impd token.                                        |
| `image`     | impd's     | The image a new imp boots.                                                 |
| `memoryMib` | impd's     | The memory a new imp gets.                                                 |
| `guestDir`  | `/tmp/atc` | The folder inside each imp that atc's files go under.                      |
| `guestATC`  | unset      | An atc binary already installed in the image, for hooks to report through. |

Set at most one of `tokenEnv` and `tokenFile`. A target that sets both is a config error, and each
spawn on it fails with `target_config_invalid`. A target with neither calls impd with no token.

A target that sets `tokenEnv` to a variable that is unset or empty when the daemon starts is a
config error. The daemon prints the variable's name at startup, never a value, lists the error in
`targetErrors`, and refuses each spawn on the target until the variable is set and the daemon
restarts.

`tokenFile` keeps the token out of the daemon's environment, so a systemd unit can pass it as a
credential:

```ini
[Service]
LoadCredential=imp-token:/etc/atc/imp-token
```

```json
{
  "provider": "imp",
  "url": "http://impd.tail:7070",
  "tokenFile": "/run/credentials/atc-daemon.service/imp-token"
}
```

The daemon reads the file at startup and again before each call and connection to impd, dropping one
trailing newline. A file that is missing, unreadable, or empty at startup is a config error the
daemon handles like an unset `tokenEnv` variable, printing the path and never the content. Rewrite
the file to rotate the token: the next call and connection to impd use the new one, with no restart.
systemd mounts `/run/credentials` read-only, so to rotate a credential it passes, change the source
file and restart the unit. A file that turns empty or unreadable while the daemon runs fails each
call and connection to impd as unauthorized until it holds a token again, and a spawn in that time
fails with `host_unavailable`.

A Claude session on an imp target reports through an atc inside the imp. A compiled atc daemon on
Linux copies itself in; a daemon run from source needs `guestATC`, and refuses the spawn without it.

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

## Principals

A principal is a client that reaches the daemon on someone else's behalf. Each remote MCP client is
the principal of its client ID, the one `atc clients add` prints. The `principals` key sets which
targets each principal may use. The daemon's owner, which is every connection on the local socket
that gives no principal, may use every target and is never limited by this key.

A principal reaches a session only on a target it may use, and only while that target holds the
identity the session is bound to. To the principal, every other session does not exist: lists and
the event trail leave it out, and a request for it gets the answer a session that never existed
gets. The spawn directory list leaves out the directories of spawns on targets the principal may not
use. A spawn to a target the principal may not use fails with `target_forbidden`. A principal may
not stop the daemon or restore the fleet.

A principal sees a session tree, a top-level session with its sub-sessions, only when it may use the
target of every session in it. Adding a sub-session on a target the principal may not use removes
the whole tree from its view, the parent included, as if the tree had been forgotten. Removing that
sub-session brings the tree back.

Event ids number the daemon's whole trail, so a principal's `events.read` shows gaps where the
events of sessions out of its reach sit. atc makes no claim of confidentiality against traffic
analysis: the gaps and the timing of what a principal sees can reveal that other sessions are
active.

Without a `principals` key, every principal may use the implicit `local` target alone: the target
named `local` whose provider is `local-pty` with no options. Such a principal never reaches another
target, nor a `local` that now holds another provider or other options. Its spawn without a target
fails with `target_forbidden` when `defaultTarget` is another target.

These legacy rights need a config that atc can read, or no config file at all. An existing
config.json that atc cannot use, because it is not valid JSON, its root is not an object, or atc
cannot read it, grants no principal any target until you fix it, since atc cannot read the
principals the file may hold.

Adding a `principals` key takes every principal it leaves out, and every principal it grants an
empty list, off every target. To keep a client on local sessions and grant it a further target, list
both under its client ID:

```json
{
  "principals": {
    "hV3kQ9xLm2Rt7YpZ4cWn8bJd6fGs1aEu": { "targets": ["local", "box"] },
    "Np5tXc8KqW2zLr7HyB4mVd9sGj3eFa6U": { "targets": [] }
  }
}
```

A grant holds target names, and it covers each target as the target stands now: change a target's
provider or options, and the sessions started on it before the change leave every principal's reach.
A `principals` that is not an object grants nothing to anyone, and an entry that is not an object
whose `targets` holds an array of target names grants nothing to that principal. The daemon prints
each such problem to stderr when it starts. The daemon reads `principals` once when it starts, so
restart it after you change the key.

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

A gateway's permission mode carries into every way atc runs its sessions. A `--permission-mode` in
its `args` wins over the `permissions.defaultMode` in its `settings`. A headless turn runs in that
mode. With neither set, a headless turn runs in auto mode. A resumed session takes back the mode it
was saved in unless an explicit `--permission-mode` overrides it, so atc passes a settings-only mode
as that flag when it restores a session, and in the resume command it builds.

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

### Nested harnesses

A harness you start from inside an atc session, such as `codex exec` run by a Claude session,
inherits that session's `ATC_SESSION_ID` and `ATC_SOCKET`, so its hooks report under the parent
session. Each hook command atc writes or prints carries the agent it reports for
(`hook-report --agent codex`), and the daemon drops a report whose agent differs from the session's.
A dropped report never changes the session's agent session id, last output, or state, and the
reporter exits 0.

A hook command without `--agent`, such as one installed from an older `atc codex-hooks` or
`atc grok-hooks`, reports for the session it runs in. The daemon drops it only in a session whose
own hooks have reported with an agent since the session's terminal started, so a Claude session
drops it. A Codex or Grok session whose own hooks lack the flag accepts every report under it,
nested or not. Run `atc codex-hooks` or `atc grok-hooks` again and replace the installed entries to
give those sessions the same protection.

The agent flag cannot separate a nested harness of the session's own agent, such as `codex exec`
inside a Codex session: both report as `codex`. A nested `claude` reports nothing, because atc's
Claude hooks exist only in the settings file atc passes to the sessions it starts. To keep a nested
harness of the same agent from reporting, start it with `ATC_SESSION_ID` and `ATC_SOCKET` removed
from its environment.

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
connector needs, and the [principals](#principals) key matches. ChatGPT returns to
`https://chatgpt.com/connector_platform_oauth_redirect`, and Claude returns to
`https://claude.ai/api/mcp/auth_callback` or `https://claude.com/api/mcp/auth_callback`.
[Remote MCP](../architecture/remote-mcp.md#clients) covers clients, the approval flow, and the
checks.

## State locations

Daemon state lives in `~/.local/state/atc/` — the
[architecture overview](../architecture/overview.md#state) covers the files. The daemon's sockets
and pid file sit in `$XDG_RUNTIME_DIR`, and `daemon.json` in the state directory holds their paths
for a client whose environment lacks that variable.
