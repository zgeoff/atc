# kill-forget

A user selects a session in the session list and presses `K`, then `y` at `kill selected session?`.
The daemon kills the agent and keeps the session listed with the exited mark `✗`, so it can be
revived. `K` and `y` on an exited session forget it: the row leaves the list and the daemon's state.

The journey spawns one session, so the selected row is the only row. The list reorders after a kill,
so with more sessions the second `K` can land on another row.

## Journey

```bash
bun verify use --feature kill-forget
bun verify action spawn-session --name wv-kill
bun verify terminal start atc
bun verify terminal wait --text 'control tower'
bun verify terminal press ctrl+space
bun verify terminal wait --text wv-kill
bun verify terminal type --text K
bun verify terminal wait --text 'kill selected session?'
bun verify terminal press y
bun verify terminal wait --regex '✗!? +wv-kill'
bun verify db query "select name, exited from fleet where name = 'wv-kill'"
bun verify terminal type --text K
bun verify terminal wait --text 'kill selected session?'
bun verify terminal press y
bun verify terminal wait --text 'no sessions'
bun verify db query "select count(*) as count from fleet where name = 'wv-kill'"
bun verify terminal stop
bun verify action forget-session --name wv-kill
```

## End state

- After the kill, the `wv-kill` row starts `✗`, and the first `db query` returns its row with
  `exited` 1.
- After the forget, the list holds no `wv-kill` row, and the second `db query` returns a `count`
  of 0.
- The last `forget-session` returns an empty `data.forgotten`: the TUI forgot the session already.
