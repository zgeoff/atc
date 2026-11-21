# cli-send

Check that `atc send` sends a session a message with the sender kind `local`, and that `--from` sets
the sender name. Then check that a `--wait` send exits 8 on its timeout, that
`atc message get --wait` on the same message exits 8 too, and that it exits 7 once the session
stops.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it.

- To run the atc CLI of this checkout in the run's home, use
  `bun verify cli run -- <atc arguments>`. It puts the CLI's exit status in `data.exitCode`, its
  stdout in `data.stdout` and its stderr in `data.stderr`, and its own envelope gives `ok: true`
  whatever the CLI exits with.
- When line 8 gives `status` `queued`, the session has not taken the message yet. Wait a second with
  `sleep 1`, and run line 8 again. After three reruns, treat a `status` other than `delivered` as a
  failed line. Line 10 needs line 8 to show `delivered`: the daemon ends a message with
  `session_ended` only when the session took it before it stopped.
- Treat a line as failed when its `bun verify` envelope gives `ok: false`, or when a value in
  [End state](#end-state) for that line differs. After a failed line, run line 11,
  `action forget-session`, as [Journey commands](journey-commands.md#sessions) says. Then skip
  `done` until the whole journey passes, and go on as step 5 of Check a change says.
- Replace each quoted placeholder, quotes included, with the `data.stdout` of the send on the line
  given, trimmed. That stdout holds the message id alone: `<first_id>` from line 3, `<cron_id>` from
  line 5 and `<wait_id>` from line 7.
- Expect each `--wait` on a live session to end at its `--timeout`, in seconds. The session runs the
  stand-in claude, which takes each message and never answers it. `--wait` waits for an answer, or
  for the message to end unanswered.

## Journey

```bash
bun verify use --feature cli-send
bun verify action spawn-session --name wv-send
bun verify cli run -- send wv-send "check the hangar"
bun verify cli run -- message get '<first_id>' --json
bun verify cli run -- send wv-send "ring the bell" --from cron
bun verify cli run -- message get '<cron_id>' --json
bun verify cli run -- send wv-send "anyone there" --wait --timeout 1
bun verify cli run -- message get '<wait_id>' --wait --timeout 1 --json
bun verify action stop-session --name wv-send
bun verify cli run -- message get '<wait_id>' --wait --timeout 5 --json
bun verify action forget-session --name wv-send
```

## End state

Each item gives the line of the block by its number, counted from 1. Each value sits under that
line's `data`. For a line with `--json`, each field sits in the JSON object that `stdout` holds.
"Holds" means the text appears in the field.

- Line 3: `exitCode` 0, and a message id in `stdout`.
- Line 4: `exitCode` 0, `text` `check the hangar`, `sender.kind` `local` and `sender.name`
  `atc-send`.
- Line 5: `exitCode` 0, and a message id in `stdout`.
- Line 6: `exitCode` 0, `sender.kind` `local` and `sender.name` `cron`.
- Line 7: `exitCode` 8, the message id in `stdout`, and `stderr` holds `wait_timeout`.
- Line 8: `exitCode` 8 and `status` `delivered`.
- Line 10: `exitCode` 7, `status` `unanswered` and `unansweredReason` `session_ended`.
