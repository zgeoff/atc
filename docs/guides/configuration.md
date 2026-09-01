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
  "gateways": {},
  "hooks": {},
  "leader": "ctrl-space"
}
```

| Field        | Default        | Meaning                                                                                                     |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `claudeBin`  | `"claude"`     | The binary spawned for Claude sessions.                                                                     |
| `claudeArgs` | `[]`           | Prepended to every Claude spawn, e.g. `["--model", "opus"]`.                                                |
| `grokBin`    | `"grok"`       | The binary spawned for Grok sessions.                                                                       |
| `grokArgs`   | `[]`           | Prepended to every Grok spawn. A user `--leader` in this list is dropped; atc always appends `--no-leader`. |
| `codexBin`   | `"codex"`      | The binary spawned for Codex sessions.                                                                      |
| `codexArgs`  | `[]`           | Prepended to every Codex spawn.                                                                             |
| `gateways`   | `{}`           | Claude-compatible backends, keyed by agent id. Each becomes its own row in the agent picker.                |
| `hooks`      | `{}`           | Commands the daemon runs on wire events — the [events guide](./events.md#daemon-hooks) covers them.         |
| `leader`     | `"ctrl-space"` | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                       |

## Leader

Pick a different leader when `Ctrl-Space` is taken on your machine — Raycast on macOS claims it, and
`ctrl-]` is a replacement that no common terminal, multiplexer, or OS shortcut wants. An unknown or
reserved value falls back to the default.

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

## State locations

Daemon state lives in `~/.local/state/atc/` — the
[architecture overview](../architecture/overview.md#state) covers the files. The daemon's pid file
sits in `$XDG_RUNTIME_DIR/atc-daemon.pid`, beside its sockets.
