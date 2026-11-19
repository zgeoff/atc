# cli-send

Check that `atc send` puts a message into a session's inbox, that `atc message get` reads it back
and resumes a wait, and that the exit codes a script branches on come out right.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it. Run the
lines in order, and check each value in End state when its command returns.

- `bun verify cli run -- <atc arguments>` runs the CLI of this checkout in the run's home. It
  succeeds whatever the CLI exits with, so read `data.exitCode`, `data.stdout` and `data.stderr`. A
  line fails when `data.exitCode` differs from the one End state gives.
- After a failed line, run the last line, `action forget-session`, as
  [Journey commands](journey-commands.md#sessions) says, and skip `done` on this pass. Then go on as
  step 5 of Check a change says.
- Replace each placeholder with `data.stdout` of the send that made the message, without its
  trailing newline: `<first_id>`, `<cron_id>` and `<wait_id>`.
- The session runs the stand-in claude, which runs `atc tap` and never answers a message. The tap
  takes a message and the message becomes `delivered`, so each `--wait` line times out.
- Before the stop line, run `message get <wait_id> --json` up to three more times, a second apart,
  until `status` is `delivered`. A message ends unanswered with `session_ended` only when it was
  delivered before the session stopped.

## Journey

```bash
bun verify use --feature cli-send
bun verify action spawn-session --name wv-send
bun verify cli run -- send wv-send "check the hangar"
bun verify cli run -- message get <first_id> --json
bun verify cli run -- send wv-send "ring the bell" --from cron
bun verify cli run -- message get <cron_id> --json
bun verify cli run -- send wv-send "anyone there" --wait --timeout 1
bun verify cli run -- message get <wait_id> --wait --timeout 1
bun verify action stop-session --name wv-send
bun verify cli run -- message get <wait_id> --wait --json
bun verify action forget-session --name wv-send
```

## End state

Each bullet names a `cli run` line, and each value sits under that line's `data`.

- The first send gives `exitCode` 0, and a message id in `stdout`.
- The first get gives `exitCode` 0, and `stdout` JSON with `text` `check the hangar`, `sender.kind`
  `local` and `sender.name` `atc-send`.
- The cron send gives `exitCode` 0, and its get gives `sender.name` `cron`.
- The wait send gives `exitCode` 8, the message id in `stdout`, and `wait_timeout` in `stderr`.
- The get with `--wait --timeout 1` gives `exitCode` 8 and the status in `stdout`.
- The last get, after the stop, gives `exitCode` 7, and `stdout` JSON with `status` `unanswered` and
  `unansweredReason` `session_ended`.
