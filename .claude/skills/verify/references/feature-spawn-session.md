# spawn-session

A user presses `n` in the TUI to spawn a session. The picker asks for a workspace, a name and an
initial prompt, then attaches to the new session. The run has one agent installed, the stand-in
claude, so the picker skips its agent step. The workspace list starts with the TUI's own folder, the
run's home, so Enter picks it. An empty initial prompt starts the agent with none.

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

- The last `terminal wait` exits 0: the TUI attached to the session, and the screen shows the
  stand-in's `FAKE_CLAUDE_UP` line.
- `db query` returns one row: `name` is `wv-spawn`, `agent` is `claude` and `exited` is 0.
- `forget-session` lists one id in `data.forgotten`.
