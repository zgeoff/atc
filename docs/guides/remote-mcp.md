# Remote MCP

`atc mcp --http` serves atc's MCP tools over HTTP behind OAuth, so a hosted assistant such as
ChatGPT or Claude.ai can reach your sessions with the grant scopes you approve. Nothing listens on
HTTP unless you run it, and Ctrl-C ends remote access. [OAuth](../architecture/remote/oauth.md)
covers how the server works.

## Starting the server

```bash
atc mcp --http --public-url https://<public_host>
```

The server binds `127.0.0.1:8414` unless `--host`, `--port` or the config's `mcpHTTP` block sets
another address, and `--port 0` takes a free port. Once it accepts requests, it prints its startup
line as the first line on stdout:

```text
atc mcp --http: serving <origin>/mcp, listening on http://<host>:<port>
```

atc speaks plain HTTP. Put the server behind a TLS-terminating proxy or tunnel, or reach it only
over an encrypted network. A server bound beyond loopback refuses to start without an https public
URL. To serve a tailnet, keep the loopback bind and let the tailnet's own TLS front end, such as
`tailscale serve`, carry the https origin.

## Adding a client

Add each assistant once, with the redirect URI its connector uses:

```bash
atc clients add ChatGPT --redirect-uri https://chatgpt.com/connector_platform_oauth_redirect
atc clients add Claude --redirect-uri https://claude.ai/api/mcp/auth_callback --redirect-uri https://claude.com/api/mcp/auth_callback
```

Each command prints the client ID. Enter it in the connector's OAuth settings with no secret.
`atc clients` lists the clients, and `atc clients remove <client_id>` removes one with every token
and consent it holds.

## Enrolling a passkey

You sign in to approve each connection with a passkey, so enroll one before you connect an
assistant. On the host that runs the server, print a one-time enrollment token:

```bash
atc passkeys enroll
```

1. Open `<origin>/enroll` in your browser and type the token. The token enrolls one passkey and
   expires after 15 minutes.
2. Create the passkey when the browser asks. Your device asks you to verify yourself with a PIN,
   fingerprint or face.

Expect: `Passkey enrolled.` Run `atc passkeys enroll` again to enroll a second passkey on another
device, so losing one device never locks you out. `atc passkeys` lists the enrolled passkeys with
their last use, and `atc passkeys remove <passkey_id>` removes one, such as a lost one.

Browsers refuse passkeys on an IP address. A server with no public URL serves `127.0.0.1`, so give
it `--public-url http://localhost:<port>` to sign in from a browser on the same machine.

## Approving a connection

1. Connect the assistant. The browser shows the sign-in page with the client's name and the full
   address it returns to.
2. Check the client and the return address. An approval you did not start is someone else's: do not
   sign in.
3. Select **Sign in with a passkey** and verify yourself. Five failed sign-ins end the request, and
   a request expires after 10 minutes.
4. Tick the scopes to grant on the consent page. Only `read` is ticked to start. `message` lets the
   client instruct your agents, which can run commands. It also lets the client rename, pin and mark
   your sessions read. [Scopes](../architecture/remote/mcp.md#scopes) lists the tools each scope
   allows.

The client then holds a grant. To widen it, connect again and approve the larger set. Each
connection needs a fresh sign-in, so a browser that signed in before approves nothing by itself.

## Recovering from a lost passkey

With another passkey enrolled, remove the lost one with `atc passkeys remove <passkey_id>` and keep
signing in with the other. With none left, reset the passkeys on the host:

```bash
atc passkeys enroll --reset
```

The reset removes every passkey, every unused enrollment token and every browser sign-in, then
prints a new token to enroll with. Grants stay through a removal and a reset. If someone else may
hold the lost passkey, revoke the grants made since you lost it with `atc grants`.

No recovery path runs over the network: no log line, email or link signs you in. Recovery needs a
shell on the host as the user who owns `mcp-auth.db`, so whoever has that shell can enroll a passkey
and approve connections. Guard that account as you guard the grants.

## Grants

```bash
atc grants
atc grants --revoke=<grant_id>
```

`atc grants` lists the live grants with their client, grant scopes and last use. `--revoke` deletes
a grant's tokens and the consent its client holds, and the client loses access on its next request.
A grant ID can start with a dash, which the `=` form always passes as the value.

## Running under systemd

Run the daemon and `atc mcp --http` as two user units, with the MCP unit ordered after the daemon
unit. Replace `<public_host>` with your own value:

```ini
# ~/.config/systemd/user/atc-daemon.service
[Unit]
Description=atc daemon

[Service]
ExecStart=%h/.local/bin/atc daemon
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/atc-mcp-http.service
[Unit]
Description=atc mcp --http
After=atc-daemon.service
Requires=atc-daemon.service

[Service]
Type=exec
ExecStart=%h/.local/bin/atc mcp --http --wait-for-daemon --public-url https://<public_host>
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

A daemon that atc-gateway reaches also takes `--listen` and `--token-file` in its `ExecStart`, as
the [gateway guide](./gateway.md#the-daemon-listener) describes. `--wait-for-daemon` stops the MCP
server from booting a daemon of its own. Without it, an MCP unit that finds no daemon boots one
outside the daemon unit, which takes the state lock, so the daemon unit fails on every restart and
its flags never apply. With it, the server waits up to 30 s for a daemon, then exits 1, and
`Restart=always` starts it again.

`After=` orders the MCP unit after the daemon process starts, not after its socket accepts
connections, which is the gap the wait covers. `Requires=` makes a stop or restart of the daemon
unit stop or restart the MCP unit too, which ends sign-ins in progress and keeps grants.
`atc daemon` exits 0 on SIGTERM, so the daemon unit takes `Restart=always`: under
`Restart=on-failure`, a daemon that something outside systemd stopped stays down.
