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
  "museBin": "muse",
  "museArgs": [],
  "dirs": { "roots": [] },
  "gateways": {},
  "hooks": {},
  "leader": "ctrl-space"
}
```

| Field        | Default         | Meaning                                                                                                     |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `claudeBin`  | `"claude"`      | The binary spawned for Claude sessions.                                                                     |
| `claudeArgs` | `[]`            | Prepended to every Claude spawn, e.g. `["--model", "opus"]`.                                                |
| `grokBin`    | `"grok"`        | The binary spawned for Grok sessions.                                                                       |
| `grokArgs`   | `[]`            | Prepended to every Grok spawn. A user `--leader` in this list is dropped; atc always appends `--no-leader`. |
| `codexBin`   | `"codex"`       | The binary spawned for Codex sessions.                                                                      |
| `codexArgs`  | `[]`            | Prepended to every Codex spawn.                                                                             |
| `museBin`    | `"muse"`        | The binary spawned for Muse sessions.                                                                       |
| `museArgs`   | `[]`            | Prepended to every Muse spawn.                                                                              |
| `dirs`       | `{ roots: [] }` | Where the directory picker looks beyond its own history. The [directories](#directories) section covers it. |
| `gateways`   | `{}`            | Claude-compatible backends, keyed by agent id. Each becomes its own row in the agent picker.                |
| `hooks`      | `{}`            | Commands the daemon runs on wire events — the [events guide](./events.md#daemon-hooks) covers them.         |
| `leader`     | `"ctrl-space"`  | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                       |

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

| Field          | Default     | Meaning                                                                                         |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `baseURL`      | required    | The backend's Anthropic-format endpoint. An entry without one is left out of the picker.        |
| `label`        | the id      | The row shown in the agent picker.                                                              |
| `mark`         | the id      | The overlay column letter; the first character is used.                                         |
| `bin`, `args`  | `claudeBin` | The binary and leading arguments, when the backend needs a different build of the CLI.          |
| `apiKeyHelper` | none        | Command the CLI runs to read the credential, so no token is written into atc's state directory. |
| `env`          | `{}`        | Extra environment for the session, such as the model each Claude tier maps to.                  |

The id may not be `claude`, `grok`, or `codex`. atc writes one settings file per id and passes it as
`--settings`, on the terminal spawn and on a headless turn alike, so a gateway session reaches its
own backend rather than whatever the terminal exported. Two backends may be given the same `mark`;
atc does not check, and a clash makes them indistinguishable in the overlay column.

## Attention hooks (Grok, Codex, and Muse)

Claude needs no install step: atc instruments each spawned Claude session through a generated
`--settings` file, and your global Claude settings are untouched. Grok, Codex, and Muse take their
instrumentation from your own agent config, so each is a one-time self-install — atc prints the
hooks and never writes them.

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

Muse hooks live in the `hooks` block of `$XDG_CONFIG_HOME/muse/settings.json`
(`~/.config/muse/settings.json` when `XDG_CONFIG_HOME` is unset). Muse has no `--settings`
equivalent, so the entries cannot be handed over per spawn:

1. Run `atc muse-hooks` and merge the printed entries into the `hooks` block of that file.
2. Leave your own entries in that block in place — the printed output covers the atc reporter only.

Muse spells its hook payload keys the way Claude does, so the same reporter reads both. It reports
no transcript path, so atc pulls session names from `$XDG_DATA_HOME/muse/session-index.db` instead,
opened read-only.

Sessions you start outside atc report events too; the reporter exits immediately when no atc session
id is present.

## State locations

Daemon state lives in `~/.local/state/atc/` — the
[architecture overview](../architecture/overview.md#state) covers the files. The daemon's pid file
sits in `$XDG_RUNTIME_DIR/atc-daemon.pid`, beside its sockets.
