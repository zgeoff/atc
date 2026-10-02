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
Exposing it to the internet (a tunnel, Tailscale, a reverse proxy) is your job, and Ctrl-C ends
remote access.

The authorization server keeps its state in `~/.local/state/atc/mcp-auth.db`, a SQLite file separate
from `atc.db`. The daemon never opens it. `atc clients` and `atc grants` open it directly, so they
work whether or not the server is running. The file holds clients, consent, short-lived owner
sessions, and SHA-256 hashes of access tokens, refresh tokens, and authorization codes, never one of
those three in the clear.

The HTTP process keeps pending approvals in memory and signs each authorization request with a
secret it draws at start. Restarting it ends the approvals in progress; grants survive.

When the daemon restarts, the HTTP process reconnects on its next request. A tool call in flight at
that moment fails, because a spawn or a message must not run twice. A read-only tool call is the
exception: it is retried once on a fresh connection.

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

- the owner: one user, signed in for a single authorization by the approval code atc prints
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
| `POST /mcp`                                                                        | one JSON-RPC message, answered with JSON                  |

Every other path is a 404, including the client, consent, and session management endpoints
better-auth defines. The origin is the public URL you configure, reduced to a bare origin, or
`http://127.0.0.1:<port>` without one. It is the OAuth issuer, and `<origin>/mcp` is the one
resource every token is bound to. The authorization server metadata advertises S256 PKCE only and
`none` as the only client authentication method.

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
   `Approve Claude (returns to claude.ai) with code K7QM-2XRT. The code expires in 10 minutes.` in
   the terminal running `atc mcp --http`, and the browser shows the approval code page with the full
   redirect URI. The right code signs in the owner for this one authorization. A wrong code shows
   the page again, and the fifth wrong code ends the request. Each client holds at most 3 waiting
   approvals, and a fourth drops its oldest. At most 16 approvals wait at once, and a seventeenth
   drops the oldest. At most 10 approvals start per minute across every client, which bounds how
   fast approval lines print.
4. Consent. The consent page lists the scopes the client requested, with only `read` ticked to
   start; `message` lets the client instruct your agents, which can run commands. Allowing redirects
   back with an authorization code for the ticked scopes; denying, or allowing nothing, redirects
   back with `access_denied`. better-auth refuses a scope the client did not request. Either answer
   clears the owner session cookie.
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

The owner session that approves an authorization ends 30 minutes after sign-in. Once a code is
exchanged, atc detaches every token from its session, so a session's end never ends a grant.

A refresh rotates both tokens. Presenting a spent refresh token again counts as replay: better-auth
revokes every refresh token the client holds, so each of that client's grants has to be approved
again.

`atc grants` lists the live grants with their client, scopes, and last use.
`atc grants --revoke <id>` deletes a grant's tokens and the consent its client holds.

## Scopes

Each tool declares one of 4 scopes, as the [overview](./overview.md#mcp-server) describes.
`tools/list` returns every tool whatever the token holds. A `tools/call` for a tool outside the
token's scopes gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the
missing scope; a tool atc does not know needs `kill`. To widen a grant, the client connects again
and you approve the larger set. A message sent through `atc_session_message` from a remote client
carries the client's name as its sender, and the tool's `from` argument is ignored.

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
  dynamic value on them is escaped, and the client name printed in the terminal has its control and
  format characters dropped.
- Protocol version. A request whose `MCP-Protocol-Version` header holds a version atc does not speak
  gets an empty 400, so a newer client falls back to `initialize`.
- Transport. The server answers each `POST /mcp` with JSON and does not open a server-to-client
  stream, so `GET /mcp` gets 405. JSON-RPC batches get a 400.

better-auth's telemetry stays off: `atc mcp --http`, `atc clients`, and `atc grants` turn it off in
their own environment before better-auth starts, so a `BETTER_AUTH_TELEMETRY` variable you set
cannot turn it on.
