# gateway-routing

Check that atc-gateway routes a tool call to the daemon over the daemon's TCP listener, and that the
daemon refuses a gateway with the wrong token. Run the journey on `local` when `bun verify report`
shows this feature with `changed: true`. Run [On prod](#on-prod) only when your task asks you to
read the deployed gateway.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it. Run the
commands in order, and check each value in End state when its command returns.

- A command fails when it exits non-zero, or when `mcp call` gives `data.isError: true`.
  `bun verify mcp call` exits 0 when the tool fails, and puts the tool's reason in `data.content`.
- After a failed command, run the last one, `action forget-session`. Skip `done` on this pass, and
  go on as step 5 of Check a change says. `forget-session` stops the session if it still runs, and
  does nothing when no session has the name.
- `up` starts two gateways, `gateway` with the daemon's token and `gateway-wrong` with another. Each
  names the daemon `verify`, the name you see in `structuredContent.daemons`. `bun verify` signs
  each `--server` command in as the run's service client.
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

Each bullet names a command, and each value sits under that command's `data`.

- The call through `gateway` gives `isError: false`, and a session whose `name` is `wv-gateway` in
  `structuredContent.sessions`. `structuredContent.daemons` is exactly
  `[{"name":"verify","state":"up"}]`.
- The call through `gateway-wrong` gives `isError: false`, and an empty
  `structuredContent.sessions`. `structuredContent.daemons` is exactly
  `[{"name":"verify","state":"unauthorized"}]`.
- `handshake-refusals` gives at least one entry in `refusals`, and each has `reason` `unauthorized`.

## On prod

On `prod`, the deployed atc gateway, run only the reads below, and record no verdict. `prod` keeps
its evidence in `.wringer/`. `publish` puts only verdicts in the PR, so nothing from `prod` reaches
it. Leave session names and screens out of your reply: on `prod` they can hold anything. Keep your
`local` run up, for step 5.

1. Run `bun verify use --target prod`, then `bun verify use --feature gateway-routing`.
2. Run the `attach` command below. It reads the gateway's origin and the secret of the read client,
   `service:wringer-ro`, from the item `atc verify prod mcp client` in atc's 1Password vault. Set
   the two variables on this one command. Never print the secret.

   ```bash
   ATC_PROD_ORIGIN="$(op read 'op://atc/atc verify prod mcp client/origin')" ATC_PROD_MCP_SECRET="$(op read 'op://atc/atc verify prod mcp client/credential')" bun verify attach
   ```

   Expect: `ok: true` and `data.status` `running`. When `op read` fails, go to step 5, and report
   that you could not read the item.

3. Run `bun verify doctor`. Expect: `data.passed: true`, with `mcp-door` and `mcp-sign-in` passed,
   and each check that runs only on `local` reported as `skipped`. When a check fails, go to step 5,
   and report the check's name and message. The gateway keeps a sha256 digest of each client's
   secret, and two messages of `mcp-sign-in` point at it:
   - `the server has no service clients with secrets`: the gateway holds no digest for the read
     client.
   - `invalid_client`: the gateway holds another digest, or the secret came from another item.

4. Run the list. Then run a get with `<session_id>` set to the `id` of any entry in
   `structuredContent.sessions` of the list. Skip the get when the list is empty.

   ```bash
   bun verify mcp call atc_sessions_list --server gateway
   bun verify mcp call atc_session_get --server gateway --args '{"session":"<session_id>"}'
   ```

   Expect: `isError: false` on each, and the get gives the session with that `id`. A daemon whose
   `state` in `structuredContent.daemons` is not `up` refuses the read client: report its `name` and
   `state`, and go on. When a call gives `isError: true`, go to step 5, and report the reason.

5. Run `bun verify detach`, then `bun verify use --target local`, after a failure too. The run keeps
   a copy of the secret on disk to scrub it from evidence. `detach` removes the copy.

**Reply:** the doctor's result, the number of sessions the list gave, and each daemon that was not
`up`, with no session names or screens.
