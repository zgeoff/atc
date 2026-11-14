# events-stream

A user runs `atc events` to follow the fleet: one JSON line per event, starting with a
`SessionAdded` line for each session and then every change behind it. The run records the output of
`atc events` from `up` onwards as the `events` stream. A session's state change and its exit are
both `SessionState` lines, the exit with the state `exited`.

## Journey

```bash
bun verify use --feature events-stream
bun verify action spawn-session --name wv-events
bun verify action stop-session --name wv-events
bun verify session-events --name wv-events
bun verify action forget-session --name wv-events
```

## End state

- `session-events` exits 0. Its `data.events` starts with `SessionAdded`, holds a `SessionState`
  line with a state other than `exited`, and later one with `exited`.
- `bun verify stream read events` shows the raw lines, when you need them.
