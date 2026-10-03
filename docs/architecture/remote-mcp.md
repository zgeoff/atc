# Remote MCP

`atc mcp --http` serves atc's MCP tools over streamable HTTP at `/mcp`, so a hosted assistant such
as ChatGPT or Claude.ai can reach the fleet. An OAuth 2.1 authorization server runs in the same
process: better-auth's OAuth provider handles the protocol, and atc adds the parts that make it
single-user. Only clients you add with `atc clients add` can connect, and you approve every
authorization with a code atc prints in its terminal. Each grant carries scopes that limit which
tools the client can call. Nothing listens on HTTP unless you run `atc mcp --http`; the TUI and the
stdio `atc mcp` server work the same either way.

## Process model

`atc mcp --http` is a foreground process beside the daemon and a client of the daemon's socket, like
`atc mcp`. It binds `127.0.0.1:8414` unless `--host`, `--port`, or config sets another address.
Exposing it to the internet is your job, and Ctrl-C ends remote access.

atc speaks plain HTTP and does not terminate TLS. Plain HTTP must never cross an untrusted network,
so put the server behind a TLS-terminating reverse proxy or tunnel, or reach it only over an
encrypted, authenticated network such as a WireGuard tailnet. A listener bound beyond loopback must
sit behind TLS: when `--host` is not a loopback address, the server refuses to start without an
https public URL. To serve a tailnet, keep the loopback bind and let the tailnet's own TLS front
end, such as `tailscale serve`, carry the https origin.

The authorization server keeps its state in `~/.local/state/atc/mcp-auth.db`, a SQLite file separate
from `atc.db`, readable and writable by its owner only: atc creates it with mode 600 and sets that
mode again on every open. The daemon never opens it. `atc clients` and `atc grants` open it
directly, so they work whether or not the server is running. The file holds clients, consent,
short-lived owner sessions, and SHA-256 hashes of access tokens, refresh tokens, and authorization
codes, never one of those three in the clear.

The HTTP process keeps pending approvals in memory and signs each authorization request with a
secret it draws at start. Restarting it ends the approvals in progress; grants survive.

The server prints one line per request to stderr: the method, the path without its query, the
status, the time taken, and for an MCP request its JSON-RPC method, tool name, and
`MCP-Protocol-Version` header, as in
`POST /mcp 200 41ms rpc=tools/call tool=atc_message_get mcp-protocol-version=2025-06-18`. A line
holds no request body, query, cookie, or header other than `MCP-Protocol-Version`, and no address.
The path, JSON-RPC method, tool name, and version come from the client and appear as sent, without
control characters or whitespace and cut to a fixed length, so a client that puts a secret in one of
them puts it in the line. The lines are always on, since the terminal running `atc mcp --http` is
your own. Approval lines go to stdout, so redirecting stderr keeps them on screen. The startup line
shows the address the server is bound to, such as `http://100.67.122.120:8414` with
`--host 100.67.122.120`.

When the daemon restarts, the HTTP process reconnects on its next request. A read-only tool call in
flight at that moment is retried once on a fresh connection. So is a spawn or a message, when the
daemon announces `spawn.idempotency` or `message.idempotency`: the server sends it under an
idempotency key, the one the tool call passed or one it mints, and retries under the same key, so
the daemon runs it at most once. The retry needs the fresh daemon to announce the feature too.
Against a daemon without the feature, a spawn or a message in flight fails, because it must not run
twice.

`atc_session_spawn` and `atc_session_message` take an optional `idempotencyKey` of 1 to 180
characters, and the server refuses any other value with `bad_args` before it sends the daemon
anything; the [protocol](./protocol.md#idempotent-requests) covers what a retry under a key returns.
A key lets a client retry its own tool call safely. Against a daemon that does not announce the
feature, the server leaves the input out of `tools/list` and refuses a call that passes it with
`daemon_outdated`. When a spawn from inside a session falls back to top-level because the calling
session is gone, the fallback has different params, so it runs under a key of its own: `top-level:`
and the SHA-256 of the caller's key in hex. A retry derives the same key, and the derived key always
fits the daemon's 200-character cap.

## Gateway

`atc-gateway` serves the same MCP tools and authorization server for several daemons at once, and
routes each call over TCP to one daemon in its registry. It ships as its own release binary,
`atc-gateway-linux-x64`, compiled from `src/gateway.ts`. The binary holds no daemon, PTY, or agent
code, and `bun run check:imports` fails when the entry reaches any. It never starts a daemon or a
session on its own machine, so a call to a daemon that does not answer fails.

```bash
atc-gateway serve --host 0.0.0.0 --port 8414 --public-url https://atc.example.com --registry /etc/atc-gateway/registry.json --state-dir /var/lib/atc-gateway
```

| Flag           | Value                                                                      | Default                  |
| -------------- | -------------------------------------------------------------------------- | ------------------------ |
| `--host`       | the address to bind                                                        | `127.0.0.1`              |
| `--port`       | the port to listen on                                                      | `8414`                   |
| `--public-url` | the origin clients reach, the OAuth issuer; the resource is `<origin>/mcp` | required                 |
| `--registry`   | the registry file                                                          | required                 |
| `--state-dir`  | the directory for `gateway.db` and `mcp-auth.db`                           | `$ATC_GATEWAY_STATE_DIR` |

The registry file lists each daemon by name with its TCP address and the daemon ID that
`atc daemon id` prints on its host, plus the daemon a spawn without one goes to:

```json
{
  "daemons": { "cloud": { "address": "100.64.0.7:8415", "daemonID": "<daemon_id>" } },
  "defaultDaemon": "cloud"
}
```

The bearer token for each daemon comes from `ATC_GATEWAY_TOKEN_<NAME>`, the name upper-cased with
`-` as `_`, such as `ATC_GATEWAY_TOKEN_CLOUD`. It is a token from that daemon's
[token file](./daemon.md#the-tcp-listener). A registry that cannot be read or parsed, or a daemon
without its token, makes the gateway print each problem to stderr and exit 1. The bind rule of
`atc mcp --http` holds: a host other than loopback needs an https public URL.

The gateway writes only in its state directory: `gateway.db` holds the bindings for retried spawns
and messages, and `mcp-auth.db` the authorization server. With neither `--state-dir` nor
`ATC_GATEWAY_STATE_DIR`, it exits 1. It has no default under a home directory, so one volume holds
all its state.

The gateway reads `--state-dir` anywhere on its command line: before the subcommand, between
`clients` and its subcommand, or after it. A flag beats `ATC_GATEWAY_STATE_DIR`. The gateway exits 1
before it opens a database in 3 cases:

- two `--state-dir` flags give different directories
- a flag it does not know appears anywhere, such as `--stat-dir`
- a flag's separate value is missing or starts with `-`, as in `--redirect-uri --state-dir <dir>`;
  write such a value as `--<flag>=<value>`

`/healthz` and `/readyz` are always on. Each returns 200 for a request whose `Host` header is the
public URL's host, such as `atc.example.com`, and 403 for any other host, so an orchestrator's probe
sets that header. Approval lines go to stdout and request lines to stderr, so you read the approval
code in the gateway's log. SIGTERM stops the server and exits 0.

Manage the gateway's clients with the same binary, in the same state directory, while it runs:

```bash
atc-gateway clients add Claude --redirect-uri https://claude.ai/api/mcp/auth_callback --state-dir /var/lib/atc-gateway
atc-gateway clients list --state-dir /var/lib/atc-gateway
atc-gateway clients remove <client_id> --state-dir /var/lib/atc-gateway
```

## What runs where

better-auth runs the OAuth protocol through `@better-auth/mcp`, which configures
`@better-auth/oauth-provider` for MCP:

- request validation at the authorization endpoint: client, exact redirect URI, scopes, PKCE, and
  the resource indicator (RFC 8707)
- authorization codes, opaque access tokens, rotating refresh tokens with reuse detection, and
  revocation (RFC 7009)
- the authorization server metadata (RFC 8414) and the protected resource metadata (RFC 9728)
- the `iss` parameter on every authorization response (RFC 9207)

atc adds the rest:

- the owner: one user, signed in for a single authorization by the approval code atc prints, with
  that session bound to the one request the code approved
- the login and consent pages, and the parameters atc sets on every authorization request
- the bearer check on `/mcp` and the per-tool scope check
- the route list, the Host and Origin checks, and the page headers
- `atc clients` and `atc grants`

## Clients

A client is a public client you add by hand: no client secret, PKCE with S256 required, and every
atc scope open to request. atc offers no dynamic client registration and fetches no client ID
metadata documents, so a client the operator never added cannot start an authorization.

```bash
atc clients add ChatGPT --redirect-uri https://chatgpt.com/connector_platform_oauth_redirect
atc clients add Claude --redirect-uri https://claude.ai/api/mcp/auth_callback --redirect-uri https://claude.com/api/mcp/auth_callback
```

Each command prints the client ID; enter it in the connector's OAuth settings with no secret. A
redirect URI must be https, or http on a loopback host, with no fragment. `atc clients` lists the
clients, and `atc clients remove <id>` removes one with every token and consent it holds.

## Endpoints

| Path                                                                               | Purpose                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` and `.../oauth-protected-resource/mcp` | protected resource metadata: the resource `<origin>/mcp`  |
| `GET /.well-known/oauth-authorization-server`                                      | authorization server metadata                             |
| `GET /oauth2/authorize`                                                            | start an authorization request                            |
| `GET /login`, `POST /login`                                                        | the approval code page                                    |
| `GET /consent`, `POST /consent`                                                    | the consent page                                          |
| `GET /error`                                                                       | the page for a request refused before any redirect        |
| `POST /oauth2/token`                                                               | exchange an authorization code, or rotate a refresh token |
| `POST /oauth2/revoke`                                                              | revoke a token                                            |
| `POST /mcp` and `POST /`                                                           | one JSON-RPC message, answered with JSON                  |

Every other path is a 404, including the client, consent, and session management endpoints
better-auth defines. The origin is the public URL you configure, reduced to a bare origin, or
`http://127.0.0.1:<port>` without one. It is the OAuth issuer, and `<origin>/mcp` is the one
resource every token is bound to. The authorization server metadata advertises S256 PKCE only and
`none` as the only client authentication method. atc accepts Bearer tokens alone, so neither
metadata document advertises DPoP.

`POST /` serves MCP the same way as `POST /mcp`, for a client configured with the bare origin. Both
paths are the one resource `<origin>/mcp`: the 401 challenge and the protected resource metadata
point at `<origin>/mcp` from either path, and a token bound to `<origin>/mcp` works at `/`.

## Connecting a client

A client connects in 5 stages:

1. Discovery. An unauthenticated `POST /mcp` gets a 401 whose `WWW-Authenticate` header points at
   the protected resource metadata, which points at the authorization server metadata.
2. Authorization. Before better-auth sees `GET /oauth2/authorize`, atc sets `prompt=login consent`,
   adds `offline_access` to the requested scope, and sets `resource=<origin>/mcp` when the client
   gave no resource. The prompt makes every authorization ask for a fresh approval code and show the
   consent page, whatever session or consent a browser kept. `offline_access` makes better-auth
   issue a refresh token. An unknown client or a redirect URI the client was not added with gets an
   error page and is never redirected; every later error redirects back with an OAuth error. A
   resource other than `<origin>/mcp` gets `invalid_target`.
3. Approval code. A valid request prints a line such as
   `Approve Claude (returns to claude.ai) with code K7QM-2XRT. Requested from 203.0.113.7 (reported by CF-Connecting-IP), user agent "Claude-User/1.0". The code expires in 10 minutes.`
   in the terminal running `atc mcp --http`, and the browser shows the approval code page with the
   full redirect URI. The requester is the `CF-Connecting-IP` address when the request carries that
   header, marked as reported because any client can send it, and otherwise the address the
   connection came from, which behind a proxy or tunnel is the proxy's. The user agent is cut to 60
   characters. Check both before typing a code: an approval you did not start is someone else's. The
   right code signs in the owner for this one authorization and binds the new session to that
   request alone. A wrong code shows the page again, and the fifth wrong code ends the request. Each
   client holds at most 3 waiting approvals, and a fourth drops its oldest. At most 16 approvals
   wait at once, and a seventeenth drops the oldest. At most 10 approvals start per minute across
   every client, which bounds how fast approval lines print.
4. Consent. The consent page and its answer require the session the approval code signed in, for the
   request that code approved; any other request, a query whose signature fails, or a query still at
   the login stage gets an error page. The page lists the scopes the client requested, with only
   `read` ticked to start; `message` lets the client instruct your agents, which can run commands.
   Allowing redirects back with an authorization code for the ticked scopes; denying, or allowing
   nothing, redirects back with `access_denied`. better-auth refuses a scope the client did not
   request. One login answers one consent: either answer ends the session's binding and clears its
   cookie, so the session can approve nothing else.
5. Token exchange. `POST /oauth2/token` exchanges the code within 10 minutes. The request must
   present the same `client_id` and `redirect_uri` as the authorization request and a
   `code_verifier` matching its S256 challenge. A code is exchangeable once; a second exchange fails
   and revokes the tokens the first one produced.

## Grants and tokens

A grant is everything one authorization code produced: the refresh tokens rotated from it and the
access tokens each issued. Access and refresh tokens are opaque.

| Credential         | Lifetime                       |
| ------------------ | ------------------------------ |
| access token       | 1 hour                         |
| refresh token      | 30 days from its last rotation |
| authorization code | 10 minutes, one exchange       |
| pending approval   | 10 minutes                     |

Every `/mcp` request checks its access token against the database through better-auth, so a revoked
grant loses access on its next request. The check also requires the token's audience to be
`<origin>/mcp`. When the public URL changes, the server drops the resource the earlier URL served,
so a token bound to it stops working.

One login approves exactly one authorization. A consent answer that issues no code deletes the owner
session. An answer that issues a code shortens the session to the code's 10 minutes, because
better-auth refuses a code exchange whose session is gone, and the exchange deletes it. Once a code
is exchanged, atc detaches every token from its session, so a session's end never ends a grant.

A refresh rotates both tokens. Presenting a spent refresh token again counts as replay: better-auth
revokes every refresh token the client holds, so each of that client's grants has to be approved
again.

`atc grants` lists the live grants with their client, scopes, and last use.
`atc grants --revoke=<id>` deletes a grant's tokens and the consent its client holds. A grant ID can
start with a dash, which the `=` form always passes as the value.

## Scopes

Each tool declares one of 4 scopes, as the [overview](./overview.md#mcp-server) describes.
`tools/list` returns every tool whatever the token holds. A `tools/call` for a tool outside the
token's scopes gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the
missing scope; a tool atc does not know needs `kill`. To widen a grant, the client connects again
and you approve the larger set. A message sent through `atc_session_message` from a remote client
carries the client's name as its sender, and the tool's `from` argument is ignored.

`atc_agents_list` needs only `read`. It returns the agents the host can run, with whether each
binary is installed and what each agent supports, and the host's name, platform, architecture, and
atc build, so a client can choose an agent before spawning. It never returns a gateway's
environment, credential helper, or base URL; the [protocol](./protocol.md#agents) covers the fields.

`atc_session_spawn` takes an optional `model` and `effort`, and refuses any value the agent's
`spawnOptions` in `atc_agents_list` does not list as available; the
[protocol](./protocol.md#spawn-options) covers the rules. Against a daemon that does not announce
`spawn.options`, the server leaves both inputs out of `tools/list` and refuses a call that passes
either with `daemon_outdated`, sending the daemon nothing. That daemon returns no `spawnOptions`, so
the server lists `atc_agents_list` without its output schema. Otherwise the input schema is the same
on every host. Its description, and its `agent` field's description, list the agents the daemon
registered when the server built the `tools/list` answer, marking any whose binary is missing as not
installed. A token without `read` gets descriptions that list no agent, since listing agents is a
read. A client can cache that answer, so `atc_agents_list` is the current source.

The answer `atc_message_get` returns is the final output of the session turn that carried the
message, which can carry other messages too; the [protocol](./protocol.md#messages) covers the turn
id and `answeredWith`. Pass `waitMs` to `atc_message_get` and `atc_events_read` instead of polling
in a tight loop: each holds the request for up to 30 seconds, under the server's 60-second idle
limit.

A report event from `atc_events_read` holds a 600-character preview of the report's text.
`atc_report_get` takes the cursor of that event and returns the whole text, up to 64 KiB, without
messaging the session that sent it. It needs only `read`, and it reaches only the sessions
`atc_events_read` does. Against a daemon that does not announce `report.get`, the server leaves the
tool out of `tools/list` and refuses a call with `daemon_outdated`, sending the daemon nothing.

## Request checks

- Host. Every request must carry a `Host` header of the public origin's host, `127.0.0.1:<port>`,
  `localhost:<port>`, or a host in `mcpHTTP.allowedHosts`; anything else gets 403. This stops a DNS
  rebinding page from reaching the server through a browser on your machine.
- Origin. A form post to `/login` or `/consent` must carry an `Origin` header of the public origin
  or the local address, and a request to `/mcp` that carries an `Origin` header must come from one
  of those.
- Pages. The login, consent, and error pages carry a Content Security Policy that blocks scripts and
  frames and limits form posts to atc and the client's redirect origin, plus
  `X-Frame-Options: DENY`, `Cache-Control: no-store`, and `Referrer-Policy: same-origin`. Every
  dynamic value on them is escaped, and the client name, requester address, and user agent printed
  in the terminal have their control and format characters dropped. The error page shows a fixed
  sentence for each error code better-auth sends there and a generic one for any other, never text
  from the link, so a crafted link cannot put its own words on atc's origin.
- Protocol version. A request whose `MCP-Protocol-Version` header holds a version atc does not speak
  gets an empty 400, so a newer client falls back to `initialize`.
- Principal. Every daemon request a client's tool call makes acts as the client's ID, so the daemon
  limits it to the targets the [principals](../guides/configuration.md#principals) key grants that
  ID. A daemon that predates principals gets no request from the server.
- Transport. The server answers each `POST /mcp` with JSON and does not open a server-to-client
  stream, so `GET /mcp` and `GET /` get 405. JSON-RPC batches get a 400.

better-auth's telemetry stays off: `atc mcp --http`, `atc clients`, and `atc grants` turn it off in
their own environment before better-auth starts, so a `BETTER_AUTH_TELEMETRY` variable you set
cannot turn it on.
