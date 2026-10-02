# Remote MCP

`atc mcp --http` serves atc's MCP tools over streamable HTTP at `/mcp`, so a hosted assistant that
cannot start a local process can reach the fleet. Access goes through atc's own single-user OAuth
2.1 authorization server. You approve each client with a code atc prints in its terminal, and each
grant carries scopes that limit which tools the client can call. Nothing listens on HTTP unless you
run `atc mcp --http`; the TUI and the stdio `atc mcp` server do not change.

## Process model

`atc mcp --http` is a foreground process beside the daemon and a client of the daemon's socket, like
`atc mcp`. It listens on `127.0.0.1` only, on port 8414 unless `--port` or config sets another.
Exposing it to the internet (a tunnel, Tailscale, a reverse proxy) is your job, and Ctrl-C ends
remote access.

State splits between the two processes:

- The daemon keeps grants, token hashes, and registered clients in `atc.db`, behind the `grant.*`
  protocol methods. Tokens never reach the daemon, only their SHA-256 hashes, and no method returns
  a hash.
- The HTTP process keeps pending approvals, authorization codes, and fetched client metadata in
  memory. Restarting it drops approvals in progress and codes not yet exchanged; grants survive.

When the daemon restarts, the HTTP process reconnects on its next request. A request in flight at
that moment fails and is not retried, because a refresh or a spawn must not run twice. Two requests
are the exception: checking an access token and looking up a registered client change nothing beyond
a grant's last-use time, so running one twice is harmless and each is retried once on a fresh
connection. A daemon too old to hold grants makes `atc mcp --http` exit with a hint to restart it.

## Endpoints

| Path                                                                               | Purpose                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /.well-known/oauth-protected-resource` and `.../oauth-protected-resource/mcp` | protected resource metadata (RFC 9728): the resource `<origin>/mcp` and its authorization server |
| `GET /.well-known/oauth-authorization-server`                                      | authorization server metadata (RFC 8414)                                                         |
| `POST /register`                                                                   | dynamic client registration (RFC 7591) for public clients                                        |
| `GET /authorize`                                                                   | start an authorization request and show the approval page                                        |
| `POST /authorize`                                                                  | the approval page's form                                                                         |
| `POST /token`                                                                      | exchange an authorization code, or rotate a refresh token                                        |
| `POST /mcp`                                                                        | one JSON-RPC message, answered with JSON                                                         |

The origin is the public URL you configure, reduced to a bare origin, or `http://127.0.0.1:<port>`
without one. It is the OAuth issuer, and `<origin>/mcp` is the one resource every grant is bound to.
The authorization server metadata advertises S256 PKCE only, `none` as the only client
authentication method, client ID metadata documents, and the `iss` parameter on authorization
responses (RFC 9207).

## Connecting a client

A client connects in 5 stages:

1. Discovery. An unauthenticated `POST /mcp` gets a 401 whose `WWW-Authenticate` header points at
   the protected resource metadata, which points at the authorization server metadata.
2. Client identity. A client whose id is an https URL is identified by the client ID metadata
   document at that URL. atc fetches it only when the host is in `mcpHTTP.clientMetadataHosts`, only
   when every address the host resolves to is public, and never follows a redirect. Any other client
   registers through `POST /register` and gets an id the daemon minted. A registered client that
   gains no grant within 10 minutes is pruned.
3. Authorization. `GET /authorize` checks the client and the redirect URI first. An unknown client
   or a redirect URI the client never registered gets an error page and is never redirected. Every
   later error redirects back with an OAuth error, and every redirect, success or error, carries
   `iss`. A valid request prints a line such as
   `Approve ChatGPT (verified by chatgpt.com; returns to chatgpt.com) with code K7QM-2XRT` in the
   terminal running `atc mcp --http`, and the browser shows the approval page. A registered client
   is labelled `unverified, registered itself` instead, on the page and in the terminal, because its
   name is only what it claims; the page also shows the full redirect URI.
4. Approval. You type the code and choose the scopes. The page starts with only `read` checked;
   `message` lets the client instruct your agents, which can run commands, so it starts unchecked
   with `spawn` and `kill`. A wrong code shows the page again, and the fifth wrong code ends the
   request. Each client holds at most one waiting approval, and a new one replaces it. At most 5
   approvals wait at once, and a sixth drops the oldest. Each client starts at most 20 per hour, and
   each approval waits 10 minutes. Approving redirects back with an authorization code; denying, or
   approving with no scope checked, redirects back with `access_denied`.
5. Token exchange. `POST /token` exchanges the code within 60 seconds. The request must present the
   same `client_id` and `redirect_uri` as the authorization request and a `code_verifier` matching
   its S256 challenge. A code is exchangeable once; a second exchange fails and revokes the grant
   the first one produced.

## Grants and tokens

Each grant holds one access token and one refresh token, both opaque: a kind prefix (`atc_at_`,
`atc_rt_`) and 32 random bytes in base64url.

| Credential         | Lifetime                       |
| ------------------ | ------------------------------ |
| access token       | 1 hour                         |
| refresh token      | 30 days from its last rotation |
| authorization code | 60 seconds, one exchange       |
| pending approval   | 10 minutes                     |

Every `/mcp` request checks its access token with the daemon, so a revoked grant loses access on its
next request. The check also requires the token's grant to be bound to this server's resource.

A refresh rotates both tokens. Presenting a spent refresh token again revokes the whole grant, with
one exception: within 2 minutes of the rotation, while the new pair is still unused, atc treats it
as a retry from a client that lost the response and issues a fresh pair.

`atc grants` lists the live grants with their client, scopes, creation time, and last use.
`atc grants --revoke <id>` revokes one.

## Scopes

Each tool declares one of 4 scopes, as the [overview](./overview.md#mcp-server) describes.
`tools/list` returns every tool whatever the grant holds. A `tools/call` for a tool outside the
grant's scopes gets HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` and the
missing scope; to widen a grant, the client connects again and you approve the larger set. A message
sent through `atc_session_message` from a remote client carries the client's name as its sender, and
the tool's `from` argument is ignored.

## Request checks

- Host. Every request must carry a `Host` header of the public origin's host, `127.0.0.1:<port>`,
  `localhost:<port>`, or a host in `mcpHTTP.allowedHosts`; anything else gets 403. This stops a DNS
  rebinding page from reaching the server through a browser on your machine.
- Origin. A request to `/mcp` that carries an `Origin` header must come from the public origin or
  the local address, and the approval form must carry one of those origins.
- Approval page. It is served with a Content Security Policy that blocks scripts and frames and
  limits form posts to atc and the client's redirect origin, plus `X-Frame-Options: DENY`. Every
  dynamic value on it is escaped.
- Protocol version. A request whose `MCP-Protocol-Version` header holds a version atc does not speak
  gets an empty 400, so a newer client falls back to `initialize`.
- Transport. The server answers each `POST /mcp` with JSON and does not open a server-to-client
  stream, so `GET /mcp` gets 405. JSON-RPC batches get a 400.
