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

| Field                   | Default          | Meaning                                                                                                                                             |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                | `{ claude: {} }` | The agents atc offers, keyed by agent id. The [agents](#agents) section covers the fields of an entry.                                              |
| `dirs`                  | `{ roots: [] }`  | Where the directory picker looks beyond its own history. The [directories](#directories) section covers it.                                         |
| `authProfiles`          | unset            | Credential references an agent's `auth` selects from. The [brokered credentials](#brokered-credentials) section covers them.                        |
| `hooks`                 | `{}`             | Commands the daemon runs on wire events — the [events guide](./events.md#daemon-hooks) covers them.                                                 |
| `leader`                | `"ctrl-space"`   | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                                                               |
| `targets`               | unset            | Where sessions run, keyed by target id. The [targets](#targets) section covers it.                                                                  |
| `defaultTarget`         | unset            | The target a spawn without a target runs on.                                                                                                        |
| `workspaces`            | see above        | Where workspaces come from and land. The [git transports](#git-transports) and [workspace destinations](#workspace-destinations) sections cover it. |
| `restoreFleetOnRestart` | `true`           | Whether the daemon restores the fleet by itself after a restart. The [fleet restore](#fleet-restore) section covers it.                             |

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

## Workspace destinations

A spawn whose workspace is a git repository clones it into a new directory on its target. When the
spawn gives no directory, atc picks `<root>/<repo>-<ref>-<short sha>`, such as
`~/.local/share/atc/workspaces/app-main-c2e799e`. The spawn picker's confirm screen shows that path
and takes it on Enter, and an `atc_session_spawn` call without `cwd` gets it the same way. The short
sha is left out of the name when the spawn gives only a ref.

The root is `workspaces.targets.<target id>` when set, else `workspaces.root`, else
`~/.local/share/atc/workspaces`:

```json
{
  "workspaces": { "root": "~/workspaces", "targets": { "cloud": "/srv/work" } }
}
```

A root that starts with `~` resolves on the target. On the daemon's own machine `~` is the daemon
user's home. On a remote target, such as an imp, the daemon passes the path relative to the home and
the host resolves it, since only that host knows its home. Any other root must be an absolute path.

When the picked directory exists, or another session's workspace holds it, the daemon tries the same
path with `-2`, `-3`, and so on, up to `-100`. It claims each directory with `mkdir`, so repeated
and concurrent spawns of one repository land side by side and never write into a directory that
already exists. The session's working directory holds the path the workspace landed in, and the
session list shows it.

A destination you type replaces the picked one. It must be an absolute path on the target, and `~`
in it expands only on the daemon's own machine.

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

### Clone trust

Claude asks a person to trust a workspace folder before its first session there, and an agent caller
cannot answer that prompt. To accept trust for one launch, pass `trustClonedWorkspace: true` with a
`workspace` source to `session.spawn` or `atc_session_spawn`. atc accepts trust only after it
verifies the clone, and only for the clone's resolved root, so a sibling or parent folder still
asks. Trust allows Claude to load the repository's configuration and helpers, so use the option only
for repositories you trust. It changes no tool permission mode.

- On a `local-pty` target, the launch must use stock Claude. atc adds one entry for the clone root
  to your own Claude config (`~/.claude.json`, or `.claude.json` in `$CLAUDE_CONFIG_DIR`), under the
  lock Claude itself writes that file under, and leaves every other entry as it is. A launch that
  fails before Claude starts takes the entry back. The entry holds folder trust alone, so Claude
  still asks you to approve the MCP servers in the clone's `.mcp.json`.
- On an imp target, the launch must use a brokered Claude gateway or stock Claude with `auth`; see
  [brokered credentials](#brokered-credentials). atc seeds the trust in the session's own guest
  config, where it also approves every MCP server in the clone's `.mcp.json`, so the session starts
  those servers without asking. Claude Code moves that approval into the clone's
  `.claude/settings.local.json` on its first start. A launch without trust asks a person to approve
  the servers.

atc refuses trust for any other agent or target, and for a launch without a workspace source.

On an imp target, a launch that signs in through the broker reads the clone's own Claude settings
before Claude starts, and fails with `auth_target_unsupported` when they would override that
sign-in; see [Claude subscription on imps](#claude-subscription-on-imps). A brokered gateway gets
the same check.

Set `targets.<target_id>.trustClonedWorkspace` to a boolean to give that target a default. An
explicit `trustClonedWorkspace: true` or `false` on the launch overrides it; omitting both keeps
trust off. An inherited `true` has the same restrictions as an explicit `true`, so an ordinary
folder launch on that target must pass `false`. Changing this target option changes its identity, as
other target options do; existing sessions remain bound to the previous target configuration.

### imp targets

An `imp` target runs each top-level session in an imp of its own, a VM that impd hosts, and keeps
each sub-session in its parent's imp. A kill of the top-level session puts its imp to sleep, and
`session.forget` destroys it. The [daemon architecture](../architecture/daemon.md#the-imp-provider)
covers the lifecycle. Its options:

| Key                    | Default    | What it does                                                                                         |
| ---------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `url`                  | required   | Where impd listens. Without it the target lists as unavailable.                                      |
| `impPrefix`            | `atc-`     | The start of every imp name the target builds.                                                       |
| `tokenEnv`             | unset      | The environment variable of the daemon that holds the impd token.                                    |
| `tokenFile`            | unset      | The file that holds the impd token.                                                                  |
| `image`                | impd's     | The image a new imp boots.                                                                           |
| `memoryMib`            | impd's     | The memory a new imp gets.                                                                           |
| `guestDir`             | `/tmp/atc` | The folder inside each imp that atc's files go under.                                                |
| `guestATC`             | unset      | An atc binary already installed in the image, for hooks to report through.                           |
| `trustClonedWorkspace` | `false`    | Default for clone trust; an explicit launch value takes precedence. See [clone trust](#clone-trust). |

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

Each imp name is `impPrefix` followed by the first 20 letters and digits of the id of the session
that owns the imp. Give atc a namespace of its own on a shared impd by setting `impPrefix`, such as
`harness-`, and scope the impd token's imp patterns to it (`harness-*`). The prefix is a lowercase
letter followed by up to 10 lowercase letters, digits or hyphens, so every name it builds is one
impd accepts. Any other value is a config error the daemon handles like an unset `tokenEnv`
variable.

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
fails with `target_forbidden` when `defaultTarget` is another target. A request over the daemon's
[TCP listener](../architecture/daemon.md#the-tcp-listener) never gets these rights: it may act only
as a principal the `principals` key lists, so a config without the key admits no TCP request.

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

## Agents

`agents` holds exactly the agents atc offers, keyed by agent id. An entry that is not listed does
not exist: `"agents": {}` offers no agent, and every spawn fails with
`no adapter for agent 'claude'`. The first run writes `{ "claude": {} }`, so a machine with Grok or
Codex adds an entry for each:

```json
{
  "agents": {
    "claude": { "args": ["--model", "opus"] },
    "codex": {},
    "grok": { "bin": "/opt/grok/bin/grok" }
  }
}
```

| Field          | Default                              | Meaning                                                                                                                                                                             |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | the id                               | The CLI the entry drives: `claude`, `codex`, or `grok`. It is required for any other id.                                                                                            |
| `label`        | `Claude`, `Codex`, `Grok`, or the id | The row shown in the agent picker.                                                                                                                                                  |
| `mark`         | the first character of the id        | The overlay column letter; the first character is used.                                                                                                                             |
| `bin`          | the kind's binary name               | The binary spawned for the entry's sessions.                                                                                                                                        |
| `args`         | `[]`                                 | Prepended to every spawn. A spawn's own model or effort replaces the matching flag.                                                                                                 |
| `settings`     | none                                 | Claude only. More Claude Code settings for the entry's sessions; [extra session settings](#extra-session-settings) covers them.                                                     |
| `env`          | `{}`                                 | Claude only. Extra environment for the session, such as the model each Claude tier maps to.                                                                                         |
| `baseURL`      | none                                 | Claude only. The backend's Anthropic-format endpoint; an entry that sets it is a [gateway](#gateways).                                                                              |
| `apiKeyHelper` | none                                 | Claude only, with `baseURL`. Command the CLI runs to read the credential.                                                                                                           |
| `auth`         | none                                 | Claude only. The credential profiles impd's broker applies; [brokered credentials](#brokered-credentials) and [Claude subscription on imps](#claude-subscription-on-imps) cover it. |

`kind` defaults to the id for `claude`, `codex`, and `grok`, so `"codex": {}` is a Codex entry. A
`kind` that contradicts one of those three ids, such as `"codex": { "kind": "claude" }`, is refused.
The ids `""` and `__proto__` are refused.

atc parses each entry strictly. An entry that is not an object, sets an unknown field, holds a
wrong-typed value, or sets a field its kind does not take is left out, and the daemon prints one
line for each problem when it starts, such as `agents.codex: baseURL is not valid for kind codex`.
The other entries load. An `agents` value that is not an object leaves the registry empty and prints
`agents must be an object of agent entries`.

Codex and Grok take `args` as well as `bin`. A `--leader` or `--no-leader` in a Grok entry's `args`
is dropped, since atc always appends `--no-leader`. A spawn's model replaces a `-m` or `--model` in
a Codex entry's `args`.

### Several entries per harness

Each entry has its own id, binary, arguments, settings, and generated settings file, so several
entries of one kind run side by side. Two Claude entries differ in model and settings:

```json
{
  "agents": {
    "claude": { "args": ["--model", "opus"] },
    "claude-fast": {
      "kind": "claude",
      "label": "Claude (fast)",
      "args": ["--model", "haiku"],
      "settings": { "outputStyle": "terse" }
    }
  }
}
```

atc writes one settings file per id and passes it as `--settings`. Entries of kind Codex or Grok
share the hook file you install, which prints the kind as the agent for every entry of it. The
daemon accepts those hook lines for every Codex or Grok entry; the
[attention hooks](#attention-hooks-grok-and-codex) section covers the install.

### Picker order and the default agent

The agent picker and `agents.list` follow the order of `agents` in the file. An agent whose binary
does not resolve is left out of the picker. A spawn that names no agent runs `claude` when the
registry has an entry with that id, and the first entry otherwise. With an empty registry,
`agents.list` still reports `claude` as the default, and the spawn fails because no adapter is
registered for it.

## Gateways

A Claude entry with a `baseURL` is a gateway: it runs the Claude CLI against a Claude-compatible
backend, under its own agent id. Claude and GLM sessions then sit side by side in one fleet:

```json
{
  "agents": {
    "claude": {},
    "zai": {
      "kind": "claude",
      "label": "GLM (z.ai)",
      "mark": "z",
      "baseURL": "https://api.z.ai/api/anthropic",
      "apiKeyHelper": "~/.local/bin/atc-zai-key",
      "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2" }
    }
  }
}
```

A spawn through `atc_session_spawn` or `session.spawn` can pick a model and an effort per session;
the [protocol](../architecture/protocol.md#spawn-options) lists what each agent takes. A gateway
offers each tier its `env` maps as a model, and passes an effort on to the CLI, which its provider
may ignore.

atc writes one settings file per id and passes it as `--settings`, on the terminal spawn and on a
headless turn alike, so a gateway session reaches its own backend rather than whatever the terminal
exported. Two entries may be given the same `mark`; atc does not check, and a clash makes them
indistinguishable in the overlay column.

### Extra session settings

`settings` is a Claude Code settings object folded into the generated file, so one entry's sessions
carry hooks, permissions, or a model that no other agent gets. atc's own keys stay atc's, and a hook
list joins the fleet reporter on that event rather than replacing it. A stock Claude entry takes
`settings` and `env` the same way a gateway does.

A permission classifier is the case this exists for. Claude Code's auto mode judges nothing in a
session pointed at another backend, so a gateway session asks about every write and every command
until something else answers. A hook that answers them belongs to the gateway rather than to your
global settings:

```json
{
  "agents": {
    "zai": {
      "kind": "claude",
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
belongs to this entry's id alone.

An entry's permission mode carries into every way atc runs its sessions. A `--permission-mode` in
its `args` wins over the `permissions.defaultMode` in its `settings`. A headless turn runs in that
mode. With neither set, a headless turn runs in auto mode. A resumed session takes back the mode it
was saved in unless an explicit `--permission-mode` overrides it, so atc passes a settings-only mode
as that flag when it restores a session, and in the resume command it builds.

### Brokered credentials

A gateway entry with `auth` selects the credentials that impd's credential broker adds, on the
host's side, to requests an imp sends to the backend. The config holds secret names, never a value:

```json
{
  "authProfiles": {
    "glm": {
      "secret": "glm",
      "host": "api.z.ai",
      "header": "authorization",
      "scheme": "bearer",
      "dependencies": []
    }
  },
  "agents": {
    "glm": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "auth": {
        "profiles": ["glm"],
        "placeholderEnv": { "ANTHROPIC_AUTH_TOKEN": "imp-broker-placeholder" }
      },
      "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.6" }
    }
  }
}
```

Each profile in `authProfiles` holds a reference to a secret impd holds and the rule impd applies
with it:

| Key            | What it holds                                                                             |
| -------------- | ----------------------------------------------------------------------------------------- |
| `secret`       | The name of the secret in impd, under impd's secret name rule.                            |
| `host`         | The exact host impd adds the credential for: lowercase, no port, no wildcard, no IP.      |
| `header`       | The lowercase header impd sets, such as `authorization`.                                  |
| `scheme`       | How impd renders the value. atc binds `bearer` only.                                      |
| `kind`         | The kind of secret impd holds: `custom`, the default, or `github`.                        |
| `env`          | Variables a `custom` profile sets in a session that reaches it. See below.                |
| `dependencies` | Profiles a session selecting this one needs beside it, such as a permission classifier's. |

A `github` profile gives a session HTTPS git and the GitHub API. It holds `secret`, `kind` and
`dependencies` only, so it takes no `env`, since impd's `github` kind sets the rules:
`Authorization: Basic` for `x-access-token` on `github.com`, and a bearer `authorization` header on
`api.github.com` and `uploads.github.com`. Add the secret with
`imp secret add <secret> --kind github`, list it in the `--grantable` secrets of the target's impd
token when you make the token, and select the profile beside the model's:

```json
{
  "authProfiles": {
    "github": { "secret": "github-imp-agents", "kind": "github" }
  },
  "agents": {
    "glm": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "auth": { "profiles": ["glm", "github"] }
    }
  }
}
```

impd sets `GH_TOKEN` and `GITHUB_TOKEN` to `imp-broker-placeholder` in the session, so `gh` and
`git` run with no sign-in, and the token stays on the host. If impd changes the hosts of its
`github` kind, a launch fails with `auth_secret_mismatch` until atc's rules match again.

#### Profile variables

A `custom` profile's `env` sets variables in the guest of each session that reaches the profile,
through the entry's `auth.profiles` or a dependency. The local target never gets them. This gives a
tool in the guest the endpoint of a service the broker authenticates, such as 1Password Connect. Add
the secret with its value on stdin:

```sh
imp secret add op-connect --kind custom --hosts op-connect.geoff.cloud --header authorization --scheme bearer
```

Then add a profile that sets the variables, and select it in an agent's `auth.profiles`:

```json
{
  "authProfiles": {
    "op-connect": {
      "secret": "op-connect",
      "host": "op-connect.geoff.cloud",
      "header": "authorization",
      "scheme": "bearer",
      "env": {
        "OP_CONNECT_HOST": "https://op-connect.geoff.cloud",
        "OP_CONNECT_TOKEN": "imp-broker-placeholder"
      }
    }
  },
  "agents": {
    "claude": { "auth": { "profiles": ["claude", "op-connect"] } }
  }
}
```

`op` sends the placeholder as the bearer token, and the broker swaps in the real token on requests
to that host. A value must be exactly `imp-broker-placeholder` or `https://` followed by the
profile's own `host`, with no path and no port, so a credential is never written into the config. A
name uses capital letters, digits and underscores, and starts with a letter or underscore. atc
leaves out a profile, and refuses an entry that selects it, when its `env` sets:

- A proxy or CA variable, any variable that overrides the subscription sign-in, `PATH`, or `HOME`.
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, or a name starting with `ANTHROPIC_`, `CLAUDE_`,
  or `ATC_`.

Two selected profiles that set one variable to different values are refused, and so is an entry
whose `env` or `settings.env` sets a variable that one of its profiles sets. A change to a profile's
`env` gives the session's binding a new revision.

An entry's `auth.profiles` selects profiles, and atc adds each one's dependencies.
`auth.placeholderEnv` lists the variables that stand in for the credential, each holding
`imp-broker-placeholder`. atc refuses the entry, leaves it out of the picker, and prints the reason
when the daemon starts, when any of these holds:

- A selected profile or one of its dependencies is missing or refused, or the dependencies form a
  cycle.
- Two profiles in the expanded set send different secrets or rules to one host. atc never picks
  between them by order.
- `baseURL` is not https, has a port or user info, or its host is not one of the expanded profiles'
  hosts.
- The entry sets `apiKeyHelper`, or its `settings` set `apiKeyHelper`.
- `env`, `settings.env`, or `placeholderEnv` sets a proxy or CA variable: `HTTPS_PROXY`,
  `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, or `CURL_CA_BUNDLE`, in either
  case. impd sets these to route requests through the broker, and a value the session sets wins over
  impd's.
- `env`, `settings.env`, or `placeholderEnv` sets `ANTHROPIC_BASE_URL`, which would replace the
  checked `baseURL`.
- `env` or `settings.env` sets `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, or a variable that
  `placeholderEnv` sets, since the entry's value would replace the placeholder.

atc leaves out a profile that breaks impd's rules for secret names, hosts, or headers, and prints an
error for it, so an entry selecting it is refused as well.

A gateway with `auth` starts only on an imp target whose impd has a broker, in a session with a
broker binding. On every other target, a spawn, a resume, a restore, and an adopt each fail with
`auth_target_unsupported` before any workspace is materialized, any harness starts, or any imp is
touched. The agent picker offers the gateway only the targets with a broker. A headless turn is
refused, and the session has no resume command.

On an imp target, the session's guest folder holds a settings file for its binding revision and a
Claude config folder of its own. The settings file points the CLI at `baseURL` with the placeholder
and holds no credential helper. atc seeds the config folder with first-run onboarding state only
when `.claude.json` does not exist. Each start names a permission mode: the one the gateway's `args`
or `settings` set, else Claude's manual `default` mode.

With [clone trust](#clone-trust) on an imp target, atc seeds trust for the clone's resolved root in
that session's isolated guest config, never in the user's Claude config. atc preserves an existing
guest `.claude.json` byte for byte, so its trust decision takes precedence.

The placeholders must include `ANTHROPIC_AUTH_TOKEN`, and the profile for the `baseURL` host must
set a bearer `authorization` header, since that is the header Claude sends the variable in. Any
other placeholder variable reaches the session as it is, for a tool that runs in it, and a selected
profile for that tool's host lets impd's broker fill it. `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, and `CLAUDE_CONFIG_DIR` are the exception: Claude reads the first two as
its own credential beside `ANTHROPIC_AUTH_TOKEN`, and the broker never fills the header they feed,
while atc sets the third to the session's own config folder. Any other pairing fails with
`auth_placeholder_unsupported`, on every target and before anything is prepared, and `agents.list`
lists the gateway as unable to spawn.

A gateway that runs the auto-mode mod on an imp, with its Jev key held by impd, looks like this:

```json
{
  "authProfiles": {
    "glm": { "secret": "glm", "host": "api.z.ai", "header": "authorization", "scheme": "bearer" },
    "jev": {
      "secret": "jev-imp-agents",
      "host": "api.typesafe.ai",
      "header": "authorization",
      "scheme": "bearer"
    }
  },
  "agents": {
    "glm-auto": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "args": ["--plugin-dir", "/opt/auto-mode/mods/auto-mode"],
      "auth": {
        "profiles": ["glm", "jev"],
        "placeholderEnv": {
          "ANTHROPIC_AUTH_TOKEN": "imp-broker-placeholder",
          "TYPESAFE_API_KEY": "imp-broker-placeholder"
        }
      }
    }
  }
}
```

Add the key to impd with `imp secret add jev-imp-agents --kind=custom --hosts=api.typesafe.ai`, and
list `jev-imp-agents` in the `--grantable` list of the target's token.

### Claude subscription on imps

`auth` on a stock Claude entry, one without a `baseURL`, signs it in on an imp target with a
subscription token that impd holds, so the token never enters the imp. On the local target, Claude
keeps the sign-in of your own Claude config.

1. Run `claude setup-token` on your machine. It prints an OAuth token that bills against your Pro or
   Max subscription and lasts one year.
2. Add the token to impd as a `custom` secret on `api.anthropic.com`, with the value on stdin:

   ```bash
   imp secret add claude-setup-token --kind=custom --hosts=api.anthropic.com --header=authorization --scheme=bearer
   ```

3. List the secret in the `--grantable` secrets of the target's impd token when you make the token.
4. Add a profile for the secret and select it in the entry's `auth`, beside any other profile the
   session needs:

   ```json
   {
     "authProfiles": {
       "claude": {
         "secret": "claude-setup-token",
         "host": "api.anthropic.com",
         "header": "authorization",
         "scheme": "bearer"
       },
       "github": { "secret": "github-imp-agents", "kind": "github" }
     },
     "agents": { "claude": { "auth": { "profiles": ["claude", "github"] } } }
   }
   ```

`auth` on a stock entry holds `profiles` and the optional [`mcpServers`](#mcp-servers-on-imps), and
`placeholderEnv` is refused there: atc fixes the endpoint, `https://api.anthropic.com`, and the
placeholder, `CLAUDE_CODE_OAUTH_TOKEN=imp-broker-placeholder`. Claude Code sends that variable as a
bearer `authorization` header to `api.anthropic.com` and to no other host, and impd swaps the
placeholder for the token there. atc leaves the entry out and prints the reason when the daemon
starts if a selected profile does not resolve, or if no profile sets a bearer `authorization` header
for `api.anthropic.com`.

On an imp target, each session gets the same guest folder a brokered gateway gets: a settings file
for its binding revision that holds the placeholder, and a Claude config folder of its own that atc
seeds with first-run onboarding state, plus folder trust with [clone trust](#clone-trust). atc fills
that folder with the [Claude config bundle](#claude-config-bundle). The CLI starts without
`--permission-mode`, and atc drops one from the entry's `args`, so the auto mode the bundle sets
applies. A headless turn is refused there, as on every imp session.

Three kinds of variable keep Claude Code from sending the subscription token to the Anthropic API:
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` outrank it, `ANTHROPIC_BASE_URL` moves the endpoint,
and the `CLAUDE_CODE_USE_*` provider selectors (`BEDROCK`, `VERTEX`, `FOUNDRY`, `MANTLE`,
`ANTHROPIC_AWS`, `ANTHROPIC_GOOGLE_CLOUD`, and `GATEWAY`) select another provider. atc keeps each of
them away from a subscription session:

- The entry is refused when its `env` or `settings.env` sets any of them, `CLAUDE_CODE_OAUTH_TOKEN`,
  or a proxy or CA variable, and when its `settings` set `apiKeyHelper`. The error reads
  `agents.<id>: env must not set <variable>, which would override or route around the subscription sign-in`.
- A spawn fails with `auth_target_unsupported` when an inline `--settings` in the entry's `args`
  sets any of them, `CLAUDE_CODE_OAUTH_TOKEN`, or a proxy or CA variable.
- The session exits with status 78 before Claude starts when the imp's environment sets any of them,
  and its screen shows which one.
- A spawn, resume, restore, or adopt fails with `auth_target_unsupported` before Claude starts when
  a project settings file sets `apiKeyHelper`, or its `env` sets any of them,
  `CLAUDE_CODE_OAUTH_TOKEN`, or a proxy or CA variable. atc reads `.claude/settings.json` and
  `.claude/settings.local.json` in the folder Claude starts in, as the imp resolves it, and
  `.claude/settings.local.json` in every folder above it and in a git worktree's main checkout,
  since Claude reads that file at the repository root. Claude applies those files once the folder is
  trusted, and a person can accept that trust inside the session, so atc reads them whether or not
  the launch passes `trustClonedWorkspace`. A file that is not a JSON object, not a regular file,
  larger than 1 MiB, or unreadable fails the launch too. A spawn that cloned the folder removes the
  clone. The error's `data` holds the file's path and the setting, never its value.

The same `env` and `settings` load on a stock entry without `auth`, where nothing is bound.

A revoked grant or an expired token gives `API Error: 401` inside the session, and Claude never
falls back to another sign-in. To renew the token, run `claude setup-token` again and replace the
secret with `imp secret add claude-setup-token --replace`.

#### MCP servers on imps

`mcpServers` in a stock entry's `auth` gives each subscription session on an imp an MCP server over
HTTP whose credential impd holds. The session sends `Bearer imp-broker-placeholder` in the header
that the server's profile sets, and impd swaps in the credential for the server's host, so the
credential never enters the imp. To give sessions Linear's MCP server with a Linear personal API
key:

1. Add the key to impd as a `custom` secret on `mcp.linear.app`, with the value on stdin:

   ```bash
   imp secret add linear-imp-agents --kind=custom --hosts=mcp.linear.app --header=authorization --scheme=bearer
   ```

2. List the secret in the `--grantable` secrets of the target's impd token.
3. Add a profile for the secret, select it in the entry's `auth`, and point a server at it:

   ```json
   {
     "authProfiles": {
       "linear": {
         "secret": "linear-imp-agents",
         "host": "mcp.linear.app",
         "header": "authorization",
         "scheme": "bearer"
       }
     },
     "agents": {
       "claude": {
         "auth": {
           "profiles": ["claude", "github", "linear"],
           "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp", "profile": "linear" } }
         }
       }
     }
   }
   ```

Each server holds `url` and `profile` alone. atc writes the servers to an MCP config file in the
session's guest folder and passes it with `--mcp-config`, so Claude Code starts them without an
approval prompt. atc leaves a server out, prints the reason when the daemon starts, and keeps the
entry when any of these holds:

- `profile` is not in the entry's `auth.profiles`, or is not a `custom` profile.
- `url` is not https, has a port or user info, or its host is not the profile's `host`.
- The server's name holds a character other than a letter, a digit, `_`, or `-`.

A revoked grant leaves the placeholder in the request, and the server returns `401`. The tool call
then fails with `MCP server "linear" rejected the Authorization header in its config`, and `/mcp`
lists the server as `needs authentication`. The session has no other credential for the server. On
the local target, Claude keeps the MCP servers of your own Claude config.

#### Claude config bundle

Each launch of a stock Claude session with `auth` on an imp copies an allow-listed part of the
daemon host's Claude config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`) into the session's own
config folder, where Claude Code reads it as user settings:

- `CLAUDE.md` and `statusline.sh`
- every file under `agents/` and `output-styles/`
- each folder under `skills/` that holds a `SKILL.md`, with symlinks copied as the files they point
  at
- `settings.json`, cut to the keys below

A file its owner may execute stays executable in the guest. A symlink ships only when its target
could ship by its own path, so a link to `.credentials.json` or to the unfiltered `settings.json`
never does. The bundle leaves out every other entry, so `.credentials.json`, `.claude.json`,
history, projects, plugins, and backups stay on the host. It also leaves out any entry whose name
starts with a dot.

The bundle's `settings.json` holds these keys of the host's settings when they are set: `model`,
`effortLevel`, `advisorModel`, `outputStyle`, `autoCompactWindow`, `autoMode`, `attribution`,
`includeCoAuthoredBy`, `skipAutoPermissionPrompt`, `skipWorkflowUsageWarning`, `editorMode`, `tui`,
`permissions`, `statusLine`, and `env`. atc changes three of them on the way:

- `permissions.defaultMode` is always `auto`. Claude Code honours that mode only in user settings.
- `statusLine.command` points at the guest copy of a script the bundle ships. For `~/.claude`, atc
  also rewrites the `~/.claude` and `$HOME/.claude` spellings. atc's own statusline runs that
  command first, as it does on the host.
- `env` keeps `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` alone, since any other variable can hold a
  credential.

A repo's own `.claude/settings.json` and `.claude/settings.local.json` rank above the bundle, so
Claude Code's precedence gives a repo value over a bundle value. The `--settings` file atc writes
holds only the hooks, the statusline, the placeholder, and the entry's own `settings` and `env`, so
it never carries a bundle value above the repo's. A value the entry sets there does rank above the
repo's.

atc reads the host's folder at each launch, so a spawn or a revive after you change it starts with
the change. A running session keeps the bundle it started with. On each launch the guest replaces
every bundle entry in the session's config folder, so an entry you remove from the host leaves the
session too. The state Claude Code writes beside the bundle, `.claude.json` among it, stays.

## Migrating from the old keys

Before the `agents` map, config.json held one key per harness (`claudeBin`, `claudeArgs`, `grokBin`,
`grokArgs`, `codexBin`, `codexArgs`), `claudeAuth`, and a `gateways` map. A file with none of the
keys of `agents` and any of those loads with its old meaning: `claude`, `grok`, and `codex` entries
in that order, then each gateway the old parser accepted, in file order. The daemon prints one line
when it starts:

```text
atc daemon: config: config.json uses the old agent keys (claudeBin, gateways); run 'atc config migrate' to move them into agents
```

`atc config migrate` prints the file rewritten around `agents`, with the old keys removed and
`agents` in the place of the first of them. Each entry holds only the fields that differ from a
default. `--write` copies the file to `config.json.bak-<UTC timestamp>` beside it, then rewrites it
in place and prints both paths. `--file <path>` migrates another file.

```bash
atc config migrate
atc config migrate --write
```

A gateway the old parser left out, because it had no `baseURL`, took an id that is built in or
empty, or failed its auth checks, stays out. The command prints one line on stderr for each, such as
`atc config migrate: gateways.broken is left out: it has no baseURL`, and never prints a value. A
file that already uses `agents` and sets no removed key prints
`config.json already uses agents; nothing to migrate` and changes nothing. The command also drops a
key atc no longer reads, such as `resumeInterruptedTurns`, and prints a line on stderr naming it.

A file that sets `agents` and any old key is unusable. Every spawn fails, as for invalid JSON, and
the problem reads:

```text
claudeArgs cannot be set together with agents; move them into agents or run 'atc config migrate'
```

`atc config migrate` refuses such a file with the same message and exit code 1, so move the old keys
into `agents` by hand.

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

The installed hook files print `--agent codex` or `--agent grok` for every entry of that kind. A
second Codex entry, such as `codex-fast`, therefore needs no extra install: the daemon accepts the
lines carrying the kind for the session of every entry of that kind. A Claude entry's generated
settings file prints the entry's id instead.

Sessions you start outside atc report events too; the reporter exits immediately when no atc session
id is present.

### Nested harnesses

A harness you start from inside an atc session, such as `codex exec` run by a Claude session,
inherits that session's `ATC_SESSION_ID` and `ATC_SOCKET`, so its hooks report under the parent
session. Each hook command atc writes or prints carries the agent it reports for
(`hook-report --agent codex`), and the daemon drops a report whose agent differs from the one the
session's agent reports under: the entry id for a Claude entry, and the kind for a Codex or Grok
entry. A dropped report never changes the session's agent session id, last output, or state, and the
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

## Environment

atc takes its environment from the process that starts it: a shell, a systemd unit, or an MCP client
entry. A release binary never reads a `.env` file, so a `~/.env` line does not reach the daemon or
the sessions it starts. A variable that the starting process exports reaches atc, a stale one
included. Run from source with `bun src/cli.ts`, atc follows Bun's runtime default and loads a
`.env` file from its working directory.
