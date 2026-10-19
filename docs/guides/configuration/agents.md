# Agents and gateways

Each entry of the `agents` map is an agent atc offers: a stock Claude, Codex, or Grok CLI, or a
gateway that runs the Claude CLI against another backend. The
[brokered credentials guide](./brokered-credentials.md) covers the `auth` an entry selects
credentials with, and the [configuration guide](../configuration.md) covers the other top-level
keys.

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

| Field          | Default                              | Meaning                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | the id                               | The CLI the entry drives: `claude`, `codex`, or `grok`. It is required for any other id.                                                                                                                                                        |
| `label`        | `Claude`, `Codex`, `Grok`, or the id | The row shown in the agent picker.                                                                                                                                                                                                              |
| `mark`         | the first character of the id        | The overlay column letter; the first character is used.                                                                                                                                                                                         |
| `bin`          | the kind's binary name               | The binary spawned for the entry's sessions.                                                                                                                                                                                                    |
| `args`         | `[]`                                 | Prepended to every spawn. A spawn's own model or effort replaces the matching flag.                                                                                                                                                             |
| `settings`     | none                                 | Claude only. More Claude Code settings for the entry's sessions; [extra session settings](#extra-session-settings) covers them.                                                                                                                 |
| `env`          | `{}`                                 | Claude only. Extra environment for the session, such as the model each Claude tier maps to.                                                                                                                                                     |
| `baseURL`      | none                                 | Claude only. The backend's Anthropic-format endpoint; an entry that sets it is a [gateway](#gateways).                                                                                                                                          |
| `apiKeyHelper` | none                                 | Claude only, with `baseURL`. Command the CLI runs on the daemon's machine to read the credential.                                                                                                                                               |
| `auth`         | none                                 | Claude or Codex. The credential profiles impd's broker applies; [brokered credentials](./brokered-credentials.md), [Claude subscription on imps](./claude-subscription.md), and [Codex subscription on imps](./codex-subscription.md) cover it. |
| `pluginDirs`   | `[]`                                 | Claude only. Plugin folders every session of the entry loads; [Claude plugin folders](#claude-plugin-folders) covers them.                                                                                                                      |
| `appServer`    | `false`                              | Codex only. `true` runs each local session on a Codex App Server of its own, so the session takes messages; [Codex sessions that take messages](#codex-sessions-that-take-messages) covers it.                                                  |

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

atc starts every Codex session with `--no-daemon`, which needs Codex CLI 0.156 or later. Codex's
shared background server keeps the environment of the terminal that started it and runs the hooks
and tools of every terminal on it there. A session on that server would therefore report its hook
events, replies, and renames as the session that started the server. A Codex entry whose `args`
already hold `--no-daemon` gets no second copy, since Codex refuses a repeated flag. One whose
`args` hold `--remote` gets no `--no-daemon`, since Codex refuses the pair; its sessions report as
whatever environment the remote server runs in.

## Codex sessions that take messages

A Codex entry with `"appServer": true` takes messages that other sessions and tools send. For each
local session, the daemon starts `codex app-server` on a Unix socket of the session's own, then
starts the terminal as `codex resume <thread> --remote unix://<socket>`, so the terminal and the
daemon share one thread. The entry's `args` go to the terminal alone, without `--no-daemon` or
`--remote`, which the daemon sets.

```json
{ "agents": { "codex": { "appServer": true } } }
```

The App Server is an experimental Codex interface, so a Codex upgrade can change it. A session of
the entry on a remote target starts as a plain Codex session and refuses messages once its start-up
grace ends.

## Several entries per harness

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
daemon accepts those hook lines for every Codex or Grok entry; the [attention hooks](./hooks.md)
section covers the install.

## Picker order and the default agent

The agent picker and `agents.list` follow the order of `agents` in the file. An agent whose binary
does not resolve is left out of the picker. A spawn that names no agent runs `claude` when the
registry has an entry with that id, and the first entry otherwise. With an empty registry,
`agents.list` still reports `claude` as the default, and the spawn fails because no adapter is
registered for it.

## Claude plugin folders

To load a Claude Code plugin into every session of one Claude entry, gateways included, list its
folder in the entry's `pluginDirs`. Each folder is an absolute path or one that starts with `~/`, on
the daemon's machine:

```json
{
  "agents": {
    "claude": { "pluginDirs": ["~/plugins/review-band"] }
  }
}
```

atc passes each folder to Claude Code as `--plugin-dir` on every launch, a restore included. To load
a plugin into one session only, pass `pluginDirs` to `atc_session_spawn` or `session.spawn`; those
folders load after the entry's own. A spawn on a target that runs the agent on another machine, such
as an imp, is refused while either list holds a folder, and so is a spawn whose folder does not
exist. A different entry without `pluginDirs` starts sessions on such a target.

## Claude scratch folder

Each Claude session, a gateway's included, gets a scratch folder of its own:
`~/.local/state/atc/sessions/<session_id>/scratch` on the daemon's machine, and `scratch` in the
session's guest folder on an imp. The launch creates the folder, readable by its owner alone, and
passes it to Claude Code with `--add-dir`, so the agent reads and writes there without a prompt. The
session's `TMPDIR` points at the folder too, so a temporary file the agent or one of its tools makes
lands inside the session's working directories rather than in `/tmp`. atc keeps the folder after the
session ends.

In auto mode, Claude Code offers once to block reads outside the working directories, and the offer
waits for an answer. atc marks it seen only in an imp session's own config folder. Elsewhere, set
`"hasSeenAutoModeOutsideReadPrompt": true` in the `.claude.json` the session reads, such as
`~/.claude.json` or the imp image's.

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
the [protocol](../../architecture/agents/adapters.md#spawn-options) lists what each agent takes. A
gateway offers each tier its `env` maps as a model, and passes an effort on to the CLI, which its
provider may ignore.

atc writes one settings file per id and passes it as `--settings`, on the terminal spawn and on a
headless turn alike, so a gateway session reaches its own backend rather than whatever the terminal
exported. Two entries may be given the same `mark`; atc does not check, and a clash makes them
indistinguishable in the overlay column.

A gateway that signs in through impd's credential broker on an imp takes `auth`, and the
[brokered gateways guide](./brokered-gateways.md) covers it.

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

## Migrating from the old keys

atc 3.0.0 marks the move to the `agents` map as a breaking change. The old keys still load, but a
later major release can drop them, so migrate any config that still uses them.

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
