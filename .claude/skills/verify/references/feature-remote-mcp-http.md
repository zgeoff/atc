# remote-mcp-http

Check that `atc mcp --http` refuses a request with no token, and that a service client signs in and
lists the sessions.

Start a run on `local`, and pass `doctor`, as steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) say. Then run the journey's lines in order.

- Treat a tool call that gives `data.isError: true` as a failed line. A tool that fails still exits
  0 with `ok: true`, and gives the reason in `data.content`.
- Expect `http request` to exit 0 with the 401 in `data.status`. It fails only when no answer comes.
- At the first failed line, run the last line, `action forget-session`, and skip `done`. Then go on
  as step 5 of Check a change says. `forget-session` stops the session if it still runs, and does
  nothing when no session has the name.
- Pass no token or secret. `http request` sends none, and `--server remote` signs in for you with
  the client that `up` creates for the run.

## Journey

```bash
bun verify use --feature remote-mcp-http
bun verify action spawn-session --name wv-remote
bun verify http request --method POST --path /mcp --body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
bun verify mcp tools --server remote
bun verify mcp call atc_sessions_list --server remote
bun verify action forget-session --name wv-remote
```

## End state

Each value below sits under `data` of the command named.

- `http request` gives `status` 401, and `headers["www-authenticate"]` holds a `resource_metadata`
  URL.
- `mcp tools` gives `server` `remote`, and its list of tools holds `atc_sessions_list`.
- `mcp call` gives `isError: false`, and `structuredContent.sessions` holds a session named
  `wv-remote`.
