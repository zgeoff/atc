# mcp-fleet-tools

Check that you can drive a session with the tools of `atc mcp`: spawn it, type into it, read its
screen, stop it, and see it listed as exited.

Start a run on `local`, and pass `doctor`, as steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) say. Then run the journey's lines in order.

- Treat a tool call that gives `data.isError: true` as a failed line. A tool that fails still exits
  0 with `ok: true`, and gives the reason in `data.content`.
- At the first failed line, run the last line, `action forget-session`, and skip `done`. Then go on
  as step 5 of Check a change says. `forget-session` stops the session if it still runs, and does
  nothing when no session has the name.
- Replace `<home>` with `data.endpoints.home` from `up`: the folder the session runs in.
- Replace `<session_id>` with `data.structuredContent.id` from the spawn call.
- The stand-in claude prints each line you type into it, after `GOT:`, so typing `hi` prints
  `GOT:hi`. It prints the line after the type call answers. When the read shows no `GOT:hi`, run the
  read once more before you go on to the stop.

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

Each field below sits under `data` of the tool call named.

- Each tool call gives `isError: false`.
- The spawn gives `structuredContent.name` `wv-mcp` and `structuredContent.state` `running`.
- The type gives `structuredContent.written: true`.
- The read gives a `content` text item that holds the line `GOT:hi`.
- The stop gives `structuredContent.stopped: true`.
- In `structuredContent.sessions` of the list, the session whose `id` is `<session_id>` has `state`
  `exited` and `alive: false`.
