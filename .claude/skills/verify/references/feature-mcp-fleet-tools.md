# mcp-fleet-tools

Check that an agent drives a session with the tools of `atc mcp`: it spawns the session, types into
it, reads its screen, stops it, and lists it as exited.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup line at the end of the journey, run it, and count the feature as
failed. The cleanup line leaves the daemon with no session for the next journey.

- `up` starts four MCP servers, so pass `--server` to every `mcp` command. This journey uses `atc`,
  which is `atc mcp` over stdio in the run's home, the way a local agent reaches atc.
- `<home>` stands for `data.endpoints.home` of `up`, the folder the session runs in.
- `<session_id>` stands for `data.structuredContent.id` of the spawn call. Put it in each later
  call.
- Check `data.isError` on each call. A tool that fails still gives `ok: true`, with
  `data.isError: true` and the reason in `data.content`.
- The stand-in claude prints `GOT:` and each line typed into it.

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

When the read does not show `GOT:hi` yet, run the read once more before you count the feature as
failed. The stand-in echoes the line a moment after the type call answers.

## End state

Each field below sits under `data`.

- Every call gives `isError: false`.
- The spawn gives `structuredContent.name` `wv-mcp` and `structuredContent.state` `running`.
- The type gives `structuredContent.written: true`.
- The text in `content` of the read holds a line `GOT:hi`.
- The stop gives `structuredContent.stopped: true`.
- In `structuredContent.sessions` of the list, the session with the id `<session_id>` has `state`
  `exited` and `alive: false`.
