<div align="center">
  <h1>atc</h1>

  <p>
    Control tower for Claude Code and Grok Build sessions: stock <code>claude</code> and
    <code>grok</code> instances in PTYs behind a keyboard-driven session list with hook-driven
    attention routing — no panes, no tiling, no mouse.
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@zgeoff/atc"><img src="https://img.shields.io/npm/v/%40zgeoff%2Fatc" alt="npm version"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>
    <a href="./docs/README.md">Documentation</a> •
    <a href="./docs/architecture/overview.md">Architecture</a> •
    <a href="./AGENTS.md">Agent Guidelines</a>
  </p>
</div>

## Install

```sh
bun add -g @zgeoff/atc
atc
```

Needs [Bun](https://bun.sh) (atc runs from source through it) and the `claude` CLI on your PATH.
Grok sessions also need the `grok` CLI, and Codex sessions the `codex` CLI — the agent picker marks
an agent whose binary it cannot find as not installed and will not spawn it. From a checkout,
`bun src/cli.ts` runs the same thing. atc is built to pair with
[zoxide](https://github.com/ajeetdsouza/zoxide): the spawn directory picker feeds on its frecency
list, so with zoxide installed every directory you visit is two keystrokes from a session. Without
it the picker falls back to atc's own spawn history.

The first invocation auto-spawns the daemon (`atc daemon` runs it in the foreground for systemd or
debugging); the TUI is a thin client, so quitting or crashing it leaves every session running. Runs
fine nested inside zellij/tmux (give the pane locked mode so Ctrl-Space reaches atc).

## Keys

| Key             | Where          | Action                                                                                                                                                                  |
| --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| leader          | anywhere       | toggle session overlay — `Ctrl-Space` by default, configurable (see Config)                                                                                             |
| `n`             | home/overlay   | spawn: pick agent → dir (zoxide + history, fuzzy) → name → optional first prompt. Fresh clients default to Claude; last-used is the last deliberate-spawn SessionStart. |
| `r`             | home/overlay   | adopt: pick agent → dir → name. Claude opens `claude --resume`, Codex `codex resume`. Grok opens plain `grok`.                                                          |
| `R`             | home           | restore last fleet after a daemon death — each session with its matching CLI                                                                                            |
| `j`/`k`/`↑`/`↓` | overlay/picker | move                                                                                                                                                                    |
| `Enter`         | overlay        | attach (auto-acks)                                                                                                                                                      |
| `Tab`           | overlay        | attach the most urgent needs-you session, else the latest turn-done one                                                                                                 |
| `/`             | overlay        | fuzzy filter by name/dir (chars in order), `⏎` attach top match, `esc` clear                                                                                            |
| `a`             | overlay        | ack notification without attaching                                                                                                                                      |
| `p`             | overlay        | pin or unpin the selected session — pinned sessions stay at the top of the list                                                                                         |
| `g`             | overlay        | toggle the grouped view: sessions cluster under repository headers                                                                                                      |
| `H`             | overlay        | eject to headless (Claude only). Hidden and ignored on a Grok row.                                                                                                      |
| `P`             | overlay        | revive: a fresh terminal resumes a headless or killed session in place                                                                                                  |
| `y`             | overlay        | yank the resume command (`claude --resume <id>`, `grok --resume <id>`, or `codex resume <id>`)                                                                          |
| `Y`             | overlay        | eject: yank the resume command, then kill the session here                                                                                                              |
| `K`             | overlay        | kill selected (confirm with `y`) — the entry stays revivable with `P`, even across daemon restarts; a second `K` forgets it                                             |
| `?`             | overlay        | full key reference — the hint row only shows actions valid for the selected session                                                                                     |
| `u`             | overlay        | restart an outdated daemon and restore the fleet — offered only while `⟳ update ready` shows                                                                            |
| `q`             | home/overlay   | quit the client — sessions keep running in the daemon                                                                                                                   |

The overlay orders sessions by pinned first, then attention state, then most recently attached, so
the session you want is nearly always near the top. The grouped view (`g`) keeps that order but
clusters sessions under dim repository headers, with pinned sessions leading in their own cluster; a
git worktree clusters with its main repository, and a directory outside any repository stands alone.
A reserved column after the pin mark shows a dim `g` on Grok rows; Claude rows keep a space so names
stay aligned. The `atc_session_update` MCP tool renames and pins sessions, so an agent can organise
the fleet for you.

Revive (`P`) resumes the session from its saved transcript, so a session killed before its first
exchange has nothing on disk yet, and the overlay says so in its message column instead of resuming.
Headless eject (`H`) is Claude-only and uses the same transcript; Grok has no headless handoff.

Everything else is passed through to the focused session, which owns the full screen. Fleet state
renders inside Claude Code's own status line (injected via the same `--settings` file): your
configured statusline runs first, and atc appends `▏● 2 need you: auth-bug`. atc draws its own
status bar only on the home and overlay screens.

## How state tracking works

Spawned Claude sessions get a `--settings` file injecting `Notification`, `Stop`,
`UserPromptSubmit`, and `SessionEnd` hooks that report to a unix socket
(`$XDG_RUNTIME_DIR/atc.sock`). Your global Claude settings are untouched; sessions you start outside
atc are unaffected. Grok attention comes from a dedicated hook file at
`$GROK_HOME/hooks/atc-reporter.json` (`~/.grok` when `GROK_HOME` is unset). atc never writes that
path. Install it yourself:

```sh
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json
```

Codex attention comes from hook entries in `$CODEX_HOME/hooks.json` (`~/.codex` when `CODEX_HOME` is
unset). atc never writes that path either — `atc codex-hooks` prints the entries to merge in:

```sh
atc codex-hooks
```

Codex parses new hooks but never runs them until you trust them once: open `codex`, review the atc
hooks in its hooks list, and approve them. Sessions you start outside atc report events too; the
reporter exits immediately when no atc session id is present.

`atc grok-hooks` prints this file, with the `hook-report` command resolved for this install:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ],
    "StopCancelled": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "atc hook-report", "timeout": 5 }] }
    ]
  }
}
```

A missing file is a Grok PTY without hook-driven attention. States: red `●` needs you, cyan `◐`
running, green `✓` turn done, gray `✗` exited. The status bar turns red and names the most urgent
session.

## Config

`~/.config/atc/config.json` (created with defaults on first run):

```json
{
  "claudeBin": "claude",
  "claudeArgs": [],
  "grokBin": "grok",
  "grokArgs": [],
  "codexBin": "codex",
  "codexArgs": [],
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
| `leader`     | `"ctrl-space"` | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`.                       |

Pick a different leader when `Ctrl-Space` is taken on your machine — Raycast on macOS claims it, and
`ctrl-]` is a solid replacement that no common terminal, multiplexer, or OS shortcut wants. An
unknown or reserved value falls back to the default.

`atc mcp` exposes the fleet as MCP tools (list, spawn, drive, organise) to any MCP client, wrangled
sessions included. `atc_session_spawn` takes an optional `agent` (`claude`, `grok`, or `codex`) and
defaults to Claude; it never reads the TUI last-used value.

```sh
claude mcp add --scope user atc -- atc mcp
```

Daemon state — the restorable fleet, spawn-dir history, last-used agent, and the hook-event trail —
lives in `~/.local/state/atc/atc.db` (SQLite), next to `status.json` (read by the injected
statusline); the daemon's pid file sits in `$XDG_RUNTIME_DIR/atc-daemon.pid`, beside its sockets.

## Crash safety

A client crash or closed window costs nothing: the daemon keeps hosting the fleet, and the next
`atc` reconnects. After an update, a client meeting an older daemon keeps talking to it — killing it
would kill every hosted session — and shows `⟳ update ready` in the status bar; `u` in the overlay
restarts the daemon and restores the fleet at a moment you choose. Only a protocol mismatch, where
the two could miscommunicate, forces the restart immediately. The daemon continuously writes the
live fleet (name, cwd, agent, session id) to its SQLite store. If the daemon itself dies — crash,
SIGKILL, reboot — the child processes die with it, but every session's transcript is already on
disk. Start atc and press `R`: the whole fleet respawns with the matching CLI. Killed sessions (`K`,
`Y` eject) stay in the fleet as exited entries — restore lists them as killed without booting a
terminal, and `P` still revives them. A second `K` forgets an entry for good.

Restoring shows the whole fleet immediately — every incoming session appears in the list marked
"waiting to restore" — and revives one at a time, most recently active first: the next resume starts
only once the previous one has reported it is up (its `SessionStart` hook), so bringing back a dozen
sessions no longer launches a dozen agent processes at the same instant and pins the machine. Each
row flips live as its session comes back.
