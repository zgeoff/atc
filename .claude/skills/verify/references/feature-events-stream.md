# events-stream

Check that `atc events` reports a session's spawn, a state change and its exit, in that order.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup lines at the end of the journey, run them, and count the feature as
failed. The cleanup lines leave the daemon with no session for the next journey.

- `atc events` prints one JSON object per line. Its `ev` field holds the event's kind:
  `SessionAdded` when a session starts, and `SessionState` when its state changes. An exit is a
  `SessionState` with the state `exited`.
- `up` runs `atc events` for the whole environment and records its lines as the `events` stream.
  `use --feature` records the stream's current length, and `session-events` reads only the lines
  written after that point.
- `session-events` waits up to 5 seconds for the exit line, then fails with `check-failed`, with the
  missing event in its message. To read the recorded lines yourself, run
  `bun verify stream read events`.

## Journey

```bash
bun verify use --feature events-stream
bun verify action spawn-session --name wv-events
bun verify action stop-session --name wv-events
bun verify session-events --name wv-events
bun verify action forget-session --name wv-events
```

## End state

- Every command exits 0.
- In the JSON that `session-events` prints, each entry of `data.events` is one event of `wv-events`,
  with its `ev` and its `state`. The first entry is a `SessionAdded`, a later one is a
  `SessionState` with a state other than `exited`, and a later one still is a `SessionState` with
  `exited`.
- When `session-events` fails, run `bun verify stream read events` to read the recorded lines.
