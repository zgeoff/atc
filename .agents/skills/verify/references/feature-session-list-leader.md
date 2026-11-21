# session-list-leader

Check that `ctrl+space`, the leader key, opens the session list, that `g` groups the rows by
repository, and that `/` filters the list.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup lines at the end of the journey, run them, and count the feature as
failed. The cleanup lines leave the daemon with no session for the next journey.

- The TUI is atc's terminal client. `terminal start atc` starts it, and the title `control tower`
  shows once it has connected to the daemon, the atc process that hosts the sessions.
- `up` installs a fake claude CLI, the stand-in, as the only agent, under the agent name `claude`.
  It prints a line that starts `FAKE_CLAUDE_UP`, then asks for one permission.
- The list is a panel whose top border reads `N sessions`, with `◆ N need you` after it while
  sessions wait. The newest session comes first. So `wv-leader-b`, spawned second, is the selected
  row when the list opens.
- Each row starts with a state mark. `◆` shows while the session waits for a permission answer; the
  journey never sends that answer.
- `g` cycles the grouping from flat to repository, and the border then reads `by repo`.
- `/` opens a filter line, and the list keeps the rows whose name contains the typed text.

## Journey

```bash
bun verify use --feature session-list-leader
bun verify action spawn-session --name wv-leader-a
bun verify action spawn-session --name wv-leader-b
bun verify terminal start atc
bun verify terminal wait --text 'control tower'
bun verify terminal press ctrl+space
bun verify terminal wait --text '2 need you'
bun verify terminal screen
bun verify terminal press g
bun verify terminal wait --text 'by repo'
bun verify terminal press /
bun verify terminal type --text wv-leader-a
bun verify terminal wait --text '/ wv-leader-a'
bun verify terminal screen
bun verify terminal stop
bun verify action forget-session --name wv-leader-a
bun verify action forget-session --name wv-leader-b
```

## End state

- Every command exits 0.
- The first `terminal screen` lists a `wv-leader-b` row and a `wv-leader-a` row in the panel, each
  starting `◆`, and the top border shows `2 sessions` and `◆ 2 need you`.
- The `by repo` wait matches the top border after `g`.
- The second `terminal screen` lists a `wv-leader-a` session row and no `wv-leader-b` row.
