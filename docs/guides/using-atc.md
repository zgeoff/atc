# Using atc

Run `atc` in a terminal. The first run starts the daemon, which hosts every session you spawn, so
quitting atc leaves your sessions running.

## Spawning a session

Press `n` to spawn a session: pick an agent, pick a directory, give it a name, and type a first
prompt if you have one. The session takes the whole screen, and you work in it as you would in a
plain terminal.

The agent picker lists only the agents whose binary atc finds, and opens only when it finds more
than one. The directory picker lists the directory you ran `atc` from, atc's spawn history, every
project under the roots in `config.json`, and your [zoxide](https://github.com/ajeetdsouza/zoxide)
list when zoxide is installed. A typed path such as `~/pro` completes like a shell.

`Tab` in the picker moves to the next source the daemon offers, such as your GitHub repositories.
The GitHub list opens at once from the copy atc kept the last time it listed them, marked with its
age, and atc lists them again in the background and swaps the fresh list in when it arrives. atc
keeps that copy for a day, across client restarts; an older copy is dropped, and the picker waits
for a fresh list. Press `Ctrl-R` to list the repositories again, for example after you create one.
Typing `owner/repo` picks a repository the list leaves out.

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

The [configuration guide](./configuration.md#attention-hooks-grok-and-codex) covers both installs.

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

`atc_message_send` queues a message for a Claude Code session, which reads it in a new turn or
inside the turn it is running, and `atc_message_get` returns that turn's final output once the turn
ends. When the sender is itself a Claude Code session in atc, the outcome also arrives in the
sender's conversation as an `<atc-answer>` notice, so the sender needs no `atc_message_get` call.
Claude Code shows the agent a relayed message as one a plugin sent, not as your own prompt, so name
every write an unattended session must make, such as a push or a pull request, in its launch prompt,
where its auto-mode classifier reads your request.

## Restarting the daemon

When the daemon restarts, it restores the fleet by itself, and every session resumes from its
transcript. Set `restoreFleetOnRestart` to `false` to wait for `R` on the home screen instead.

After you upgrade atc, the status bar shows `⟳ update ready`, and `u` restarts the daemon and
restores the fleet when you are ready. When the running daemon speaks another protocol version, atc
asks before it restarts the daemon, since the restart ends every session the daemon hosts.

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

## Running the daemon under systemd

`atc daemon` runs the daemon in the foreground. Install it as the `atc-daemon.service` user unit,
and every client waits for that unit's daemon instead of starting one of its own. Start the unit
with `systemctl --user start atc-daemon.service`, and remove the unit file to return to automatic
startup. The [remote MCP guide](./remote-mcp.md#running-under-systemd) gives a unit file.
