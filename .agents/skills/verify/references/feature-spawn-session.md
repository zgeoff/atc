# spawn-session

Check that the TUI's spawn picker starts a session and attaches to it.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup lines at the end of the journey, run them, and count the feature as
failed. The cleanup lines leave the daemon with no session for the next journey.

- The TUI is atc's terminal client. `terminal start atc` starts it, and the title `control tower`
  shows once it has connected to the daemon, the atc process that hosts the sessions.
- `up` installs a fake claude CLI, the stand-in, as the only agent, under the agent name `claude`.
  It prints a line that starts `FAKE_CLAUDE_UP`, then asks for one permission.
- `n` opens the picker. With one agent, it skips the agent choice and asks for a workspace, a name
  and an initial prompt. The workspace list starts with the TUI's own folder, the run's temp home,
  so Enter picks it. Enter on an empty prompt starts the session with no prompt.

## Journey

```bash
bun verify use --feature spawn-session
bun verify terminal start atc
bun verify terminal wait --text 'control tower'
bun verify terminal press n
bun verify terminal wait --text 'spawn: workspace'
bun verify terminal press enter
bun verify terminal wait --text 'spawn: name'
bun verify terminal type --text wv-spawn
bun verify terminal press enter
bun verify terminal wait --text 'spawn: initial prompt'
bun verify terminal press enter
bun verify terminal wait --text FAKE_CLAUDE_UP
bun verify db query "select name, agent, exited from fleet where name = 'wv-spawn'"
bun verify terminal stop
bun verify action forget-session --name wv-spawn
```

## End state

- Every command exits 0. The last `terminal wait` shows the TUI attached to the session, with the
  stand-in's `FAKE_CLAUDE_UP` line on screen.
- `db query` returns one row in `data.rows`: `name` is `wv-spawn`, `agent` is `claude`, and `exited`
  is 0, the flag of a session that still runs.
- `forget-session` lists one session id in `data.forgotten`.
