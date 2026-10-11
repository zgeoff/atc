# Running atc-gateway

atc-gateway serves atc's MCP tools for several daemons through one OAuth connector. Each daemon runs
a TCP listener for the gateway, and the gateway routes each tool call to one of them.
[The gateway](../architecture/remote/gateway.md) covers how it routes.

## The daemon listener

Start each daemon the gateway reaches with a listener and a token file:

```bash
atc daemon --listen <tailnet_address>:8415 --token-file ~/.config/atc/daemon-token
```

`--listen` takes only a loopback address or a tailnet address, written as an IP literal, such as
`100.64.0.7:8415` or `[fd7a:115c:a1e4::7]:8415`. Port `0` takes a free port, and `daemon.json` in
the state directory holds the port the listener bound. The token file holds one or two tokens, one
per line, each at least 32 bytes. Under systemd, supply the file with `LoadCredential=` and point
`--token-file` at `$CREDENTIALS_DIRECTORY/<credential_name>`.

Run `atc daemon id` on the daemon's host to print its daemon ID for the registry.

### Rotating a token

1. Add the new token as a second line, then send the daemon `SIGHUP`.
2. Give the gateway the new token and restart it.
3. Remove the old token from the file.
4. Send `SIGHUP` again. The daemon closes every connection that used the old token.

A reload of a file that is invalid refuses every handshake until a reload succeeds, and the daemon
logs the reason to stderr.

### Listener log lines

The listener logs to stderr, one `key=value` line per event, for a journal alert to match:

```text
atc tcp event=listening host=127.0.0.1 port=8415
atc tcp event=handshake_refused peer=100.64.0.7 reason=unauthorized count=1
atc tcp event=principal_refused peer=100.64.0.7 principal=unlisted count=1
atc tcp event=refused peer=overflow count=1
atc log dropped=212
```

The `reason` is one of `missing_token`, `unauthorized`, `delay_cap_full`, `closed_during_delay`,
`unexpected_line` and `line_too_long`. The first refusal of one kind from one peer logs at once, and
later ones within a minute are counted onto the next line, so the counts sum to every refusal. Past
the number of peers the daemon tracks, refusals count as `peer=overflow`. `atc log dropped=N` holds
how many lines were lost while stderr took no more.

## The registry

The registry file lists each daemon by name with its TCP address and its daemon ID, plus the daemon
a spawn without one goes to:

```json
{
  "daemons": { "cloud": { "address": "100.64.0.7:8415", "daemonID": "<daemon_id>" } },
  "defaultDaemon": "cloud"
}
```

The gateway reads each daemon's token from `ATC_GATEWAY_TOKEN_<NAME>`, the name upper-cased with `-`
as `_`, such as `ATC_GATEWAY_TOKEN_CLOUD`. A registry that cannot be read or parsed, or a daemon
without its token, makes the gateway print each problem and exit 1.

Give each daemon a `principals` entry for every OAuth client the gateway serves, with the targets
that client may use ([configuration](./configuration.md#principals)).

## Serving

```bash
atc-gateway serve --host 0.0.0.0 --port 8414 --public-url https://atc.example.com --registry /etc/atc-gateway/registry.json --state-dir /var/lib/atc-gateway
```

| Flag           | Value                                                    | Default                  |
| -------------- | -------------------------------------------------------- | ------------------------ |
| `--host`       | the address to bind                                      | `127.0.0.1`              |
| `--port`       | the port to listen on; `0` for a free port               | `8414`                   |
| `--public-url` | the origin clients reach; the resource is `<origin>/mcp` | required                 |
| `--registry`   | the registry file                                        | required                 |
| `--state-dir`  | the directory for `gateway.db` and `mcp-auth.db`         | `$ATC_GATEWAY_STATE_DIR` |

A host other than loopback needs an https public URL. The gateway prints the same startup line as
`atc mcp --http`, with `atc-gateway:` in place of `atc mcp --http:`. Without a state directory it
exits 1, since it has no default under a home directory. It also exits 1 before it opens a database
when two `--state-dir` flags disagree, when a flag it does not know appears, or when a flag's
separate value is missing or starts with `-`; write such a value as `--<flag>=<value>`.

`/healthz` and `/readyz` return 200 for a request whose `Host` header is the public URL's host, and
403 for any other host, so an orchestrator's probe sets that header. Approval lines go to stdout and
request lines to stderr, so you read the approval code in the gateway's log. SIGTERM stops the
gateway and exits 0.

## Clients

Manage the gateway's clients with the same binary, in the same state directory, while it runs:

```bash
atc-gateway clients add Claude --redirect-uri https://claude.ai/api/mcp/auth_callback --state-dir /var/lib/atc-gateway
atc-gateway clients list --state-dir /var/lib/atc-gateway
atc-gateway clients remove <client_id> --state-dir /var/lib/atc-gateway
```

Approve each connection as the [remote MCP guide](./remote-mcp.md#approving-a-connection) describes,
reading the code from the gateway's log.
