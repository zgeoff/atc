# Using atc

Run `atc` in a terminal. The first run starts the daemon, which hosts every session you spawn, so
quitting atc leaves your sessions running.

## Spawning a session

Press `n` to spawn a session: pick a daemon when
[a remote daemon is connected](#opening-every-daemon-at-once), pick an agent, pick a directory or a
repository, give it a name, and type a first prompt if you have one. The session takes the whole
screen, and you work in it as you would in a plain terminal.

The agent picker lists only the agents whose binary the daemon finds and that some target can start,
and opens only when it lists more than one. After the agent, the picker shows one list that holds
every directory and repository the daemon's sources offer, grouped by source in the order of the
`sources` map in `config.json`. The directories come first in their group: the directory you ran
`atc` from, then atc's spawn history, every project under the roots in `config.json`, and your
[zoxide](https://github.com/ajeetdsouza/zoxide) list when zoxide is installed. A repository row
starts with its source id, such as `github:acme/app`. While a source lists, the list shows the grey
row `<source id>: listing…` in place of its rows, where `<source id>` is the source's key in
`sources`, and a failed listing shows its error in that row. A daemon that offers no source gets a
refusal in place of a list, as the [sources guide](./configuration/workspaces.md#sources) describes.

Typed text filters every row of the list. `Tab` moves the selection to the next source's first row,
or, while you type, to that source's best match, and wraps from the last source to the first. A
typed path, one that starts with `/`, `~` or `.`, lists only the directories it completes to, as a
shell does. Enter on a directory opens the name step. Enter on a repository opens the target step
when more than one target takes a workspace, and then the ref step. Esc on the target step returns
to the list with the repository still selected.

The GitHub rows hold up to 500 repositories that your `gh` account can access, the most recently
pushed first: your own repositories, and the ones you reach as a collaborator or an organization
member. They show at once from the copy atc kept the last time it listed them, with its age in the
list's title, and atc lists them again in the background and swaps the fresh rows in when they
arrive. atc keeps that copy for a day, across client restarts; an older copy is dropped, and the
list shows the `github: listing…` row until a fresh list arrives. Press `Ctrl-R` to list every
repository source again, for example after you create a repository.

Three typed forms reach past the listed rows when you press Enter:

- An account or organization name and a slash, such as `acme/`, lists that account's repositories in
  place of the GitHub rows.
- `owner/repo` or `github:owner/repo` picks that repository, even when the list holds only a
  repository whose name starts with the same text.
- A git URL, such as `https://example.com/acme/tool.git`, picks the repository at that URL.

A typed path always opens a directory. To spawn a repository on the daemon's host from its path,
type it as a `file://` URL, which works when `workspaces.gitTransports` holds `file`. The
[sources section](../architecture/execution/workspaces.md#sources) gives the order in which the
sources read typed text.

## The session list

`Ctrl-Space` opens the session list over whatever you are attached to. Each row carries a state
mark, and the sessions that need you sort to the top:

| Mark | State                                 |
| ---- | ------------------------------------- |
| `●`  | needs you: a prompt or question waits |
| `◐`  | running                               |
| `✓`  | turn done                             |
| `✗`  | exited                                |

| Key          | Action                                       |
| ------------ | -------------------------------------------- |
| `Ctrl-Space` | open or close the list                       |
| `Tab`        | attach the session that needs you most       |
| `Enter`      | attach the selected session                  |
| `/`          | filter by name or directory                  |
| `a`          | acknowledge a notification without attaching |
| `K`          | kill the selected session                    |
| `q`          | quit the client; sessions keep running       |
| `?`          | every other key                              |

`K` on a live session ends it, and the session stays listed as exited. On an imp, `K` puts the imp
to sleep instead, with the agent inside, and a revive wakes it where it left off. `K` again forgets
it. On a target where forgetting destroys the session's host, such as an imp, atc asks once more
before it forgets.

When you forget a session, atc takes it off the list and removes the workspace folder that atc
cloned for it. atc keeps a workspace folder that holds work found nowhere else, such as an unpushed
commit.
[Cleanup when you forget a session](./configuration/workspaces.md#cleanup-when-you-forget-a-session)
lists every reason atc keeps one, and where the list shows it.

`y` copies a shell command that resumes the selected session outside atc, and `Y` copies it and then
kills the session here. Only a session on the daemon's own machine has that command, because the
session's folder and settings file exist only where its agent runs. For a session on an imp or
another remote target, or for an agent that cannot resume outside atc, the session's message column
shows why, and `Y` kills nothing.

Inside a Claude Code session, your statusline gains a fleet segment, so `● 2 need you: auth-bug`
shows without opening the list.

atc runs inside zellij or tmux. Give the pane locked mode, so the leader key reaches atc.

## Grok and Codex hooks

Claude Code sessions report their state on their own. Grok and Codex take a one-time hook install,
which atc prints and leaves to you:

```bash
# Grok
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json

# Codex: merge the output into ~/.codex/hooks.json, then trust it once in the Codex TUI
atc codex-hooks
```

The [configuration guide](./configuration/hooks.md) covers both installs.

## Agents that drive agents

`atc mcp` exposes the fleet as MCP tools, so an agent can spawn, drive and read other agents. A
session spawned this way lists under the session that spawned it, and is killed with it. Each agent
keeps its own MCP config, so register the server once per agent:

```bash
claude mcp add --scope user atc -- atc mcp
codex mcp add atc -- atc mcp
grok mcp add atc -- atc mcp
```

A Claude Code or Codex session that is running loads the server only after it restarts. A running
Grok session loads it when you press `r` in its `/mcps` list.

To give an agent the fleet of a daemon on another host, add `--daemon <name>` with a name from the
config's [`daemons` key](./configuration.md#remote-daemons), under a server name of its own:

```bash
claude mcp add --scope user atc-box -- atc mcp --daemon box
```

That server calls only the named daemon and never starts your local one. A session it spawns is a
top-level session on that daemon, because the session that spawned it lives on your local daemon.

A Claude Code session on an imp reaches no daemon socket, so it gets atc only when its spawn grants
it. Pass `atcAccess` to `atc_session_spawn` with the scopes the session needs, such as
`["read", "message", "spawn", "kill"]`. The session then reaches itself, the sessions it spawns, and
its parent for messages alone, and it can grant a sub-session no scope it lacks itself
([a session's atc access](../architecture/protocol/principals.md#a-sessions-atc-access)).

`atc_message_send` queues a message for a Claude Code session, which reads it in a new turn or
inside the turn it is running. The session answers the message with its `answer` tool, or else with
that turn's final output once the turn ends, and `atc_message_get` returns the answer. When the
sender is itself a Claude Code session in atc, the outcome also arrives in the sender's conversation
as an `<atc-answer>` notice, so the sender needs no `atc_message_get` call. Claude Code shows the
agent a relayed message as one a plugin sent, not as your own prompt, so name every write an
unattended session must make, such as a push or a pull request, in its launch prompt, where its
auto-mode classifier reads your request.

To restart the agent process of a session on this machine, such as after a change of the account it
signs in with, a coordinating agent calls `atc_session_stop` and then `atc_session_adopt`, which
does what `P` does in the list. The stop ends the process, and the adopt starts a new one with the
conversation resumed. On an imp, the same two calls suspend and resume instead: a stop of a session
that owns its imp puts the host to sleep with the agent process inside, and the adopt wakes the host
and attaches that same process, so it keeps the login it started with. One exception: when the
host's runtime auth moved to a newer revision after that process started, such as through
`atc_session_auth_rebind`, the adopt ends the process and starts a new one, with the conversation
resumed, under the new revision's settings. A message to a stopped or sleeping session is refused
with `session_dead` until the adopt starts or resumes it. An adopt refused with
`auth_rebind_required` needs `atc_session_auth_rebind` first, then a second adopt. A pin never
blocks an adopt. A remote client needs the `kill` scope to stop and the `spawn` scope to adopt, and
may adopt only a session on a target its grant reaches, as with a stop or a forget.

## Restarting the daemon

When the daemon restarts, it restores the fleet by itself, and every session resumes from its
transcript. Set `restoreFleetOnRestart` to `false` to wait for `R` on the home screen instead.

After you upgrade atc, the status bar shows `⟳ update ready`, and `u` restarts the daemon and
restores the fleet when you are ready. When the running daemon speaks an older protocol version, atc
asks before it restarts the daemon, since the restart ends every session the daemon hosts. When your
client is the older side, such as a TUI you opened before the upgrade, atc exits and tells you to
reopen it, and the daemon keeps running.

To restart from a script or from inside a session, run:

```bash
atc daemon restart
```

The command stops the daemon, starts one in its place, restores the fleet, and prints
`restored <n> of <m>` with each session that failed. It exits 0 when every stored session came back
on the new build, and 1 otherwise.

- `--dry-run` prints what the restart would stop, and which sessions are mid-turn, then stops.
- `--timeout <seconds>` caps the wait for the restored fleet.
- `--listen` and `--token-file` override the listener flags the new daemon takes from the old one.

A session that is mid-turn loses that turn.
[Restarting the daemon](../architecture/daemon/restart.md) covers how the restart works.

## Opening a remote daemon

Run `atc --daemon <name>` to open the fleet of a daemon on another host instead of your local one.
The name selects an entry in the config's [`daemons` key](./configuration.md#remote-daemons), which
holds the daemon's address, the principal you act as, and where your token comes from. The status
bar shows `atc@<name>` while you are on a remote daemon.

The TUI connects to that daemon alone and never starts, finds, or falls back to your local one. When
the daemon is unreachable, refuses your token, or speaks another protocol version, `atc` exits 1
with the daemon's name, its address, and for a mismatch both builds and protocol versions. A
connection that drops after the TUI opens shows `⟳ waiting for daemon` and reconnects when the
daemon answers again. A reconnect that the daemon refuses, such as one with a token it no longer
holds, exits 1 with the refusal.

atc cannot restart a daemon on another host, so the TUI never offers `u` there: restart it on its
own host. A principal may not restore the fleet, so `R` restores nothing on a remote daemon.

The spawn picker lists, completes, and resolves directories on the daemon's host, through the
daemon's directory source. On a remote daemon, it leaves out the directory you ran `atc` from, a
typed `~` stands for the home of the user the daemon runs as, and a typed relative path reads from
that home. The roots and the zoxide list it shows are the daemon's own.

## Opening every daemon at once

Run `atc` with no `--daemon` flag after you add entries to the config's
[`daemons` key](./configuration.md#remote-daemons), and the list shows the sessions of your local
daemon and of each entry. A remote row starts with its daemon's name, and a local row has no name.
With no entries, the list shows your local daemon alone.

A remote daemon you cannot reach shows as one line with its name and its state, and the list hides
its rows. `down` means unreachable or dropped, and atc retries within seconds. `unauthorized` means
the token is missing or refused, and `mismatched` means another protocol version. atc retries both
every 30 seconds, so fixing the token or upgrading the daemon heals the link. A remote daemon never
ends atc.

Each action on a row goes to the daemon that holds the session. When that daemon is not up, atc
sends nothing and the status bar shows its name and state.
[The TUI and its daemons](../architecture/tui/daemon-links.md) covers refusals, confirmations and
reattaching.

`n` asks which daemon to spawn on when a remote daemon is up beside the local one. The later steps
list that daemon's directories, agents and targets. A remote daemon leaves out the directory you ran
`atc` from, and `~` stands for its home. The new session attaches on that daemon. If the daemon
drops while you pick, the picker closes and the status bar shows its state. `u`, `R` and the count
of stored sessions on the home screen act on your local daemon only.

## Running the daemon under systemd

`atc daemon` runs the daemon in the foreground. Install it as the `atc-daemon.service` user unit,
and every client waits for that unit's daemon instead of starting one of its own. Start the unit
with `systemctl --user start atc-daemon.service`, and remove the unit file to return to automatic
startup. The [remote MCP guide](./remote-mcp.md#running-under-systemd) gives a unit file.
