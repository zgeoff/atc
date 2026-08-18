<div align="center">
  <h1>atc</h1>

  <p>
    Control tower for Claude Code sessions: stock <code>claude</code> instances in PTYs behind a
    keyboard-driven session list with hook-driven attention routing — no panes, no tiling, no
    mouse.
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
From a checkout, `bun src/cli.ts` runs the same thing. atc is built to pair with
[zoxide](https://github.com/ajeetdsouza/zoxide): the spawn directory picker feeds on its frecency
list, so with zoxide installed every directory you visit is two keystrokes from a session. Without
it the picker falls back to atc's own spawn history.

The first invocation auto-spawns the daemon (`atc daemon` runs it in the foreground for systemd or
debugging); the TUI is a thin client, so quitting or crashing it leaves every session running. Runs
fine nested inside zellij/tmux (give the pane locked mode so Ctrl-Space reaches atc).

## Keys

| Key             | Where          | Action                                                                                         |
| --------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| leader          | anywhere       | toggle session overlay — `Ctrl-Space` by default, configurable (see Config)                    |
| `n`             | home/overlay   | spawn: pick dir (zoxide + history, fuzzy) → name → optional first prompt                       |
| `r`             | home/overlay   | adopt: pick dir → name → `claude --resume` (Claude's session picker opens in the new PTY)      |
| `R`             | home           | restore last fleet after a daemon death — respawns every session via `claude --resume <id>`    |
| `j`/`k`/`↑`/`↓` | overlay/picker | move                                                                                           |
| `Enter`         | overlay        | attach (auto-acks)                                                                             |
| `Tab`           | overlay        | attach the most urgent needs-you session, else the latest turn-done one                        |
| `/`             | overlay        | fuzzy filter by name/dir (chars in order), `⏎` attach top match, `esc` clear                   |
| `a`             | overlay        | ack notification without attaching                                                             |
| `p`             | overlay        | pin or unpin the selected session — pinned sessions stay at the top of the list                |
| `g`             | overlay        | toggle the grouped view: sessions cluster under repository headers                             |
| `H`             | overlay        | eject to headless: the terminal dies, a headless Agent SDK run resumes the same session        |
| `P`             | overlay        | revive: a fresh terminal resumes a headless or killed session in place                         |
| `y`             | overlay        | yank `cd <dir> && claude --resume <id>` to clipboard (OSC 52 + clip.exe/wl-copy/xclip)         |
| `Y`             | overlay        | eject: yank the resume command, then kill the session here — paste it in any pane to take over |
| `K`             | overlay        | kill selected (confirm with `y`) — the entry stays revivable with `P`; a second `K` forgets it |
| `?`             | overlay        | full key reference — the hint row only shows actions valid for the selected session            |
| `u`             | overlay        | restart an outdated daemon and restore the fleet — offered only while `⟳ update ready` shows   |
| `q`             | home/overlay   | quit the client — sessions keep running in the daemon                                          |

The overlay orders sessions by pinned first, then attention state, then most recently attached, so
the session you want is nearly always near the top. The grouped view (`g`) keeps that order but
clusters sessions under dim repository headers, with pinned sessions leading in their own cluster; a
git worktree clusters with its main repository, and a directory outside any repository stands alone.
The `atc_session_update` MCP tool renames and pins sessions, so an agent can organise the fleet for
you.

Revive (`P`) and headless eject (`H`) resume the session from its saved transcript, so both need one
to exist: a session killed before its first exchange has nothing on disk yet, and the overlay says
so in its message column instead of resuming.

Everything else is passed through to the focused Claude session, which owns the full screen. Fleet
state renders inside Claude Code's own status line (injected via the same `--settings` file): your
configured statusline runs first, and atc appends `▏● 2 need you: auth-bug`. atc draws its own
status bar only on the home and overlay screens.

## How state tracking works

Spawned sessions get a `--settings` file injecting `Notification`, `Stop`, `UserPromptSubmit`, and
`SessionEnd` hooks that report to a unix socket (`$XDG_RUNTIME_DIR/atc.sock`). Your global Claude
settings are untouched; sessions you start outside atc are unaffected. States: red `●` needs you,
cyan `◐` running, green `✓` turn done, gray `✗` exited. The status bar turns red and names the most
urgent session.

## Config

`~/.config/atc/config.json` (created with defaults on first run):

```json
{
  "claudeBin": "claude",
  "claudeArgs": [],
  "leader": "ctrl-space"
}
```

| Field        | Default        | Meaning                                                                               |
| ------------ | -------------- | ------------------------------------------------------------------------------------- |
| `claudeBin`  | `"claude"`     | The binary spawned for every session.                                                 |
| `claudeArgs` | `[]`           | Prepended to every spawn, e.g. `["--model", "opus"]`.                                 |
| `leader`     | `"ctrl-space"` | The overlay toggle: `ctrl-` plus a letter or one of `\` `]` `^` `_`, e.g. `"ctrl-]"`. |

Pick a different leader when `Ctrl-Space` is taken on your machine — Raycast on macOS claims it, and
`ctrl-]` is a solid replacement that no common terminal, multiplexer, or OS shortcut wants. An
unknown or reserved value falls back to the default.

`atc mcp` exposes the fleet as MCP tools (list, spawn, drive, organise) to any MCP client, wrangled
sessions included:

```sh
claude mcp add --scope user atc -- atc mcp
```

Daemon state — the restorable fleet, spawn-dir history, and the hook-event trail — lives in
`~/.local/state/atc/atc.db` (SQLite), next to `status.json` (read by the injected statusline); the
daemon's pid file sits in `$XDG_RUNTIME_DIR/atc-daemon.pid`, beside its sockets.

## Crash safety

A client crash or closed window costs nothing: the daemon keeps hosting the fleet, and the next
`atc` reconnects. After an update, a client meeting an older daemon keeps talking to it — killing it
would kill every hosted session — and shows `⟳ update ready` in the status bar; `u` in the overlay
restarts the daemon and restores the fleet at a moment you choose. Only a protocol mismatch, where
the two could miscommunicate, forces the restart immediately. The daemon continuously writes the
live fleet (name, cwd, Claude session id) to its SQLite store. If the daemon itself dies — crash,
SIGKILL, reboot — the child claude processes die with it, but every session's transcript is already
on disk. Start atc and press `R`: the whole fleet respawns via `claude --resume`. Only deliberate
kills (`K`, `Y` eject) remove entries from the fleet, so it stays restorable.

Restoring shows the whole fleet immediately — every incoming session appears in the list marked
"waiting to restore" — and revives one at a time, most recently active first: the next
`claude --resume` starts only once the previous one has reported it is up (its `SessionStart` hook),
so bringing back a dozen sessions no longer launches a dozen Claude processes at the same instant
and pins the machine. Each row flips live as its session comes back.
