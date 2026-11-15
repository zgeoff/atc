# remote-mcp-http

Check that `atc mcp --http` refuses a request with no token, and that the run's service client signs
in and lists the sessions. `up` starts `atc mcp --http` and creates that client for the run.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it. Run the
lines in order, and check each value in End state when its command returns.

- A line fails when its command exits non-zero, or when `mcp call` gives `data.isError: true`.
  `bun verify mcp call` exits 0 when the tool fails, and puts the tool's reason in `data.content`.
- `http request` also exits 0 on the 401. It exits non-zero only when the server sends no HTTP
  answer, such as a refused connection or a timeout. A status other than 401 is a failed line.
- After a failed line, run the last line, `action forget-session`, and skip `done` on this pass.
  Then go on as step 5 of Check a change says. `forget-session` stops the session if it still runs,
  and does nothing when no session has the name.
- Add no token or secret to any command. `http request` sends none. `bun verify` signs each
  `--server remote` command in as the run's service client.

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

Each bullet names a command, and each value sits under that command's `data`.

- `http request` gives `status` 401, and `headers["www-authenticate"]` holds a `resource_metadata`
  URL.
- `mcp tools` gives `server` `remote`, and a `tools` list with an entry whose `name` is
  `atc_sessions_list`.
- `mcp call` gives `isError: false`, and `structuredContent.sessions` holds a session whose `name`
  is `wv-remote`.
