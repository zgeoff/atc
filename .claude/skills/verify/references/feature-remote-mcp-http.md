# remote-mcp-http

Check that `atc mcp --http` refuses a call with no token, and that a service client signs in with
the OAuth `client_credentials` grant and lists the sessions.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup line at the end of the journey, run it, and count the feature as
failed.

- `up` mints a service client for the run, `service:verify-local`, and starts `atc mcp --http` on a
  loopback port with the client's secret digest in its service-token file. The `mcp` commands with
  `--server remote` sign in as that client for you, so you never pass a token or a secret.
- `http request` goes to the same server, with no token.
- Check `data.isError` on each call. A tool that fails still gives `ok: true`, with
  `data.isError: true` and the reason in `data.content`.

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

Each field below sits under `data`.

- `http request` gives `status` 401, and its `www-authenticate` header names a `resource_metadata`
  URL.
- `mcp tools` gives `server: "remote"` and a list of tools that holds `atc_sessions_list`.
- `mcp call atc_sessions_list` gives `isError: false`, and `structuredContent.sessions` holds one
  session, named `wv-remote`.
