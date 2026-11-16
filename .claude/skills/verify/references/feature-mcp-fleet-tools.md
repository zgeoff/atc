# mcp-fleet-tools

Check that you can drive a session with the tools of `atc mcp`: spawn it, type into it, read its
screen, stop it, and see it listed as exited.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it. Run the
lines in order, and check each value in End state when its command returns.

- A line fails when its command exits non-zero, or when `mcp call` gives `data.isError: true`.
  `bun verify mcp call` exits 0 when the tool fails, and puts the tool's reason in `data.content`.
- After a failed line, run the last line, `action forget-session`, as
  [Journey commands](journey-commands.md#sessions) says, and skip `done` on this pass. Then go on as
  step 5 of Check a change says.
- Replace `<home>` with `data.endpoints.home` from `up`: the folder the session runs in.
- Replace `<session_id>` with `data.structuredContent.id` from the spawn call.
- The stand-in claude prints each line you type into it, after `GOT:`, so typing `hi` prints
  `GOT:hi`. It prints the line after the type call returns, so the first read can miss it. When it
  does, run the read again. When the second read also misses it, the read is a failed line.

## Journey

```bash
bun verify use --feature mcp-fleet-tools
bun verify mcp call atc_session_spawn --server atc --args '{"cwd":"<home>","name":"wv-mcp"}'
bun verify mcp call atc_terminal_type --server atc --args '{"session":"<session_id>","text":"hi"}'
bun verify mcp call atc_terminal_read --server atc --args '{"session":"<session_id>"}'
bun verify mcp call atc_session_stop --server atc --args '{"session":"<session_id>"}'
bun verify mcp call atc_sessions_list --server atc
bun verify action forget-session --name wv-mcp
```

## End state

Each bullet names an `mcp call`, and each value sits under that call's `data`.

- Each `mcp call` gives `isError: false`.
- The spawn gives `structuredContent.name` `wv-mcp` and `structuredContent.state` `running`.
- The type gives `structuredContent.written: true`.
- The read gives a `content` text item that holds the line `GOT:hi`.
- The stop gives `structuredContent.stopped: true`.
- In `structuredContent.sessions` of the list, the session whose `id` is `<session_id>` has `state`
  `exited` and `alive: false`.
