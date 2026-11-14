# session-list-leader

A user presses the leader key, Ctrl-Space, to open the session list over whatever the TUI shows.
Each row starts with the session's state mark: `●` while the session needs you. A `!` after the mark
says the session has news you have not read. `a` acks the selected session, which clears its `!`;
the `●` stays until the session's agent moves on. `/` opens a filter that narrows the list to the
rows whose name holds the text.

Each stand-in asks for permission once it starts, so both sessions need you before the list opens.

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
bun verify terminal press a
bun verify terminal wait --regex '● {3}wv-leader-[ab]'
bun verify terminal press /
bun verify terminal type --text wv-leader-a
bun verify terminal wait --text '/ wv-leader-a'
bun verify terminal screen
bun verify terminal stop
bun verify action forget-session --name wv-leader-a
bun verify action forget-session --name wv-leader-b
```

## End state

- The first `terminal screen` lists both `wv-leader-a` and `wv-leader-b` under `sessions`, each row
  starting `●!`, and the bottom bar shows `● 2 need you`.
- The `--regex` wait exits 0: after `a`, the selected row starts `●` with no `!`.
- The second `terminal screen` lists `wv-leader-a` and no `wv-leader-b` row.
