# gateway-routing

Check that atc-gateway routes a tool call to the daemon over the daemon's TCP listener, and that the
daemon refuses a gateway that presents the wrong token. After a deploy, also run the reads in
[On prod](#on-prod) against the deployed gateway.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup line at the end of the journey, run it, and count the feature as
failed.

- `up` starts the daemon with `--listen 127.0.0.1:0 --token-file`, and two gateways that both list
  it as the daemon `verify`. `gateway` presents the daemon's token, and `gateway-wrong` presents
  another. Both take the run's service client, so the `mcp` commands sign in for you.
- The daemon's listener logs each refused handshake to its stderr, which `up` records as the
  `daemon` stream. `handshake-refusals` reads that stream since `use --feature`.
- `atc_sessions_list` through a gateway lists the sessions of every daemon it reaches, and names
  each daemon with its `state` in `structuredContent.daemons`.

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

Each field below sits under `data`.

- The call through `gateway` gives `isError: false`, `structuredContent.daemons`
  `[{"name":"verify","state":"up"}]`, and one session in `structuredContent.sessions`, named
  `wv-gateway`.
- The call through `gateway-wrong` gives `isError: false`, no session, and
  `structuredContent.daemons` `[{"name":"verify","state":"unauthorized"}]`.
- `handshake-refusals` gives at least one entry in `refusals`, each with `reason` `unauthorized`.

## On prod

`prod` is the deployed atc gateway, and only reads. Run no action there, and record no verdict: run
`done` on `local` only. The target keeps its evidence local, because a session's name or screen can
hold anything. When a read fails, give its `data` in your reply.

1. Run `bun verify use --target prod`, then `bun verify use --feature gateway-routing`.
2. Start the run with the read client `service:wringer-ro`. 1Password keeps its secret and the
   gateway's origin in the item `atc verify prod mcp client` of atc's vault, in the fields
   `credential` and `origin`. Set both variables on the `attach` command alone, and never print the
   secret. `attach` starts the run's supervisor, which keeps the secret and signs in for each later
   `mcp` command.

   ```bash
   ATC_PROD_ORIGIN="$(op read 'op://atc/atc verify prod mcp client/origin')" ATC_PROD_MCP_SECRET="$(op read 'op://atc/atc verify prod mcp client/credential')" bun verify attach
   ```

   Expect: `ok: true` and `data.status` `running`.

3. Run `bun verify doctor`. On `prod`, `mcp-door` checks that the gateway names its own `/mcp` as
   its resource, and `mcp-sign-in` checks that the client signs in. The checks of the `local` run
   report `skipped`.

   Expect: `data.passed: true`. When `mcp-sign-in` fails with
   `the server has no service clients with secrets`, the deployed gateway's service-token file holds
   no digest yet. When it fails with `invalid_client`, the file holds another digest, or the secret
   came from another item.

4. Run the two reads. Take `<session_id>` from the `id` of any session in the list.

   ```bash
   bun verify mcp call atc_sessions_list --server gateway
   bun verify mcp call atc_session_get --server gateway --args '{"session":"<session_id>"}'
   ```

   Expect: `isError: false` on each, and the get gives the session with that `id`. A daemon in
   `structuredContent.daemons` with a `state` other than `up` is one that does not grant the read
   client; report it, and go on.

5. Run `bun verify detach`, then `bun verify use --target local`. `detach` removes the run's
   `secrets.ndjson`, where the run keeps the secret to scrub it from the evidence.
