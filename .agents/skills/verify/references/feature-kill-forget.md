# kill-forget

Check that the session list kills a session, then forgets it.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup lines at the end of the journey, run them, and count the feature as
failed. The cleanup lines leave the daemon with no session for the next journey.

- The TUI is atc's terminal client. `terminal start atc` starts it, and the title `control tower`
  shows once it has connected to the daemon, the atc process that hosts the sessions.
- `up` installs a fake claude CLI, the stand-in, as the only agent, under the agent name `claude`.
  It prints a line that starts `FAKE_CLAUDE_UP`, then asks for one permission.
- In the session list, which `ctrl+space` opens, `K` then `y` at `kill selected session?` acts on
  the selected row. The journey sends `K` with `terminal type`, because `terminal press` refuses a
  capital letter.
- On a live session, it kills the agent. The row stays, marked `✗`, and its row in the `fleet` table
  of the daemon's database, which `db query` reads, gets `exited` 1.
- On an exited session, it forgets the session: the row leaves the list and the `fleet` table.

Spawn only the one session. The list moves exited rows to the bottom, so with a second session the
second `K` would act on the other row. The kill's regex accepts a `!` after the `✗`, the mark of a
change the TUI user has not looked at.

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

- Every command exits 0.
- After the kill, the `wv-kill` row starts `✗`, and the first `db query` returns its row in
  `data.rows` with `exited` 1.
- After the forget, the list shows `no sessions`, and the second `db query` returns a `count` of 0.
- The last `forget-session` returns an empty `data.forgotten`. A session id there means the TUI's
  forget never reached the daemon: the feature fails.
