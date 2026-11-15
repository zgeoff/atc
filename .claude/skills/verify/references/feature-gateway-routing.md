# gateway-routing

Check that atc-gateway routes a tool call to the daemon over the daemon's TCP listener, and that the
daemon refuses a gateway with the wrong token. Run the journey on `local` for each change. Run
[On prod](#on-prod) only when your task asks for a check of the deployed gateway.

Start a run on `local`, and pass `doctor`, as steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) say. Then run the journey's lines in order.

- Treat a tool call that gives `data.isError: true` as a failed line. A tool that fails still exits
  0 with `ok: true`, and gives the reason in `data.content`.
- At the first failed line, run the last line, `action forget-session`, and skip `done`. Then go on
  as step 5 of Check a change says. `forget-session` stops the session if it still runs, and does
  nothing when no session has the name.
- `up` starts two gateways. Each has the daemon in its config under the name `verify`, the name that
  `structuredContent.daemons` shows. `gateway` holds the daemon's token, and `gateway-wrong` holds
  another. `--server` signs in to each for you with the client that `up` creates for the run.
- `handshake-refusals` reads the refused handshakes that the daemon logged since you ran
  `use --feature`.

## Journey

```bash
bun verify use --feature gateway-routing
bun verify action spawn-session --name wv-gateway
bun verify mcp call atc_sessions_list --server gateway
bun verify mcp call atc_sessions_list --server gateway-wrong
bun verify handshake-refusals
bun verify action forget-session --name wv-gateway
```

## End state

Each value below sits under `data` of the command named.

- The call through `gateway` gives `isError: false`, `structuredContent.daemons`
  `[{"name":"verify","state":"up"}]`, and a session named `wv-gateway` in
  `structuredContent.sessions`.
- The call through `gateway-wrong` gives `isError: false`, an empty `structuredContent.sessions`,
  and `structuredContent.daemons` `[{"name":"verify","state":"unauthorized"}]`.
- `handshake-refusals` gives at least one entry in `refusals`, and each has `reason` `unauthorized`.

## On prod

Run only the reads below on `prod`, the deployed atc gateway. Run `done` for this feature on `local`
before you start, and never on `prod`. Keep the evidence of `prod` out of the PR: a session's name
or screen can hold anything.

1. Run `bun verify use --target prod`, then `bun verify use --feature gateway-routing`.
2. Run `attach` with the two variables below. Set them on this one command, and never print the
   secret. They hold the secret of the read client, `service:wringer-ro`, and the gateway's origin.
   The `prod` target signs in as that client, so the command needs no client name.

   ```bash
   ATC_PROD_ORIGIN="$(op read 'op://atc/atc verify prod mcp client/origin')" ATC_PROD_MCP_SECRET="$(op read 'op://atc/atc verify prod mcp client/credential')" bun verify attach
   ```

   Expect: `ok: true` and `data.status` `running`.

3. Run `bun verify doctor`. Expect: `data.passed: true`, with `mcp-door` and `mcp-sign-in` passed,
   and each check that runs only on `local` reported as `skipped`. When `mcp-sign-in` fails, go to
   step 5, and report its message:
   - `the server has no service clients with secrets`: the gateway holds no digest for the read
     client yet.
   - `invalid_client`: the gateway holds another digest, or the secret came from another item.

4. Run the list, then a get with the `id` of any session the list gives. Skip the get when the list
   is empty.

   ```bash
   bun verify mcp call atc_sessions_list --server gateway
   bun verify mcp call atc_session_get --server gateway --args '{"session":"<session_id>"}'
   ```

   Expect: `isError: false` on each, and the get gives the session with that `id`. Report each
   daemon in `structuredContent.daemons` whose `state` is not `up`: it does not grant the read
   client. Then go on.

5. Run `bun verify detach`, then `bun verify use --target local`, after a failure too. `detach`
   removes the copy of the secret that the run keeps on disk to scrub its evidence.
