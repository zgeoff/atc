# OAuth

`atc mcp --http` runs an OAuth 2.1 authorization server in its own process, so a hosted assistant
can reach the fleet with a grant the owner approved. The server is single-user by construction: only
clients the owner added by hand can start an authorization, and every authorization needs a fresh
approval code that atc prints in the owner's terminal. better-auth's OAuth provider runs the
protocol, and atc adds the parts that make it single-user. atc-gateway runs the same server
([the gateway](./gateway.md)).

[The MCP servers](./mcp.md#remote-callers) covers what a grant lets a client call, and the
[remote MCP guide](../../guides/remote-mcp.md) covers adding clients and approving them.

## The process

`atc mcp --http` is a foreground process beside the daemon and a client of the daemon's socket. It
speaks plain HTTP and terminates no TLS, so plain HTTP must never cross an untrusted network: a
listener bound beyond loopback refuses to start without an https public URL, which a TLS-terminating
proxy or tunnel serves. The public URL's origin is the OAuth issuer, and `<origin>/mcp` is the one
resource every token is bound to.

The server keeps its state in `mcp-auth.db`, a SQLite file separate from `atc.db`. atc creates it
readable by its owner only and sets that mode again on every open. The daemon never opens it, and
the client and grant commands open it directly, so they work whether or not the server runs. The
file holds clients, consent, short-lived owner sessions, and hashes of access tokens, refresh tokens
and authorization codes, never one of those in the clear.

Pending approvals live in memory, and the server signs each authorization request with a secret it
draws at start, so restarting the server ends the approvals in progress, and the grants survive.

## Who does what

better-auth runs the protocol: request validation at the authorization endpoint (client, exact
redirect URI, scopes, PKCE and the resource indicator), authorization codes, opaque access tokens,
rotating refresh tokens with reuse detection, revocation, and the two metadata documents. atc adds
the owner and everything around the protocol: the approval code, the login and consent pages, the
parameters it sets on every authorization request, the bearer check on the MCP endpoint and the
per-tool grant scope check, the route list, and the request checks below.

A client is a public client the owner adds by hand, with no client secret and PKCE with S256
required. atc offers no dynamic client registration and fetches no client metadata documents, so a
client the owner never added cannot start an authorization.

## Connecting a client

1. **Discovery.** An unauthenticated MCP request gets a 401 whose challenge points at the protected
   resource metadata, which points at the authorization server metadata.
2. **Authorization.** Before better-auth sees the request, atc forces a fresh login and the consent
   page, whatever session or consent a browser kept, asks for offline access so better-auth issues a
   refresh token, and sets the resource when the client gave none. An unknown client or a redirect
   URI the client was not added with gets an error page and is never redirected, so a crafted link
   cannot bounce the owner to a stranger's site.
3. **Approval code.** A valid request prints a line in the server's terminal with the client, its
   redirect, the requester's address and user agent, and a short code. The owner checks those facts
   before typing the code, since an approval the owner did not start is someone else's. The right
   code signs the owner in for this one authorization alone. The server bounds wrong codes per
   request, waiting approvals per client and in total, and approval starts per minute, which bounds
   how fast approval lines print.
4. **Consent.** The consent page requires the session the code signed in, for the request that code
   approved, and lists the scopes the client asked for with only `read` ticked to start. Either
   answer ends the session's binding, so one login approves exactly one authorization.
5. **Token exchange.** The client exchanges the code once, with the same client id and redirect URI
   and a verifier that matches its PKCE challenge. A second exchange of the same code fails and
   revokes the tokens the first produced.

## Grants and tokens

A grant is everything one authorization code produced: the refresh tokens rotated from it and the
access tokens each issued. Access tokens are short-lived, refresh tokens rotate on every use, and
the code is single-use. Every MCP request checks its access token against the database and requires
its audience to be the resource, so a revoked grant loses access on its next request, and a change
of the public URL ends every token bound to the old one. Once a code is exchanged, atc detaches its
tokens from the owner session, so a session's end never ends a grant.

Presenting a spent refresh token again counts as replay: better-auth revokes every refresh token the
client holds, and each of that client's grants needs approving again.

## Request checks

- **Host.** Every request must carry a `Host` header of the public origin, the local address or an
  allowed host, so a DNS rebinding page cannot reach the server through a browser on the owner's
  machine.
- **Origin.** A form post to the login or consent page must come from the public origin or the local
  address, and so must an MCP request that carries an `Origin` header.
- **Pages.** The login, consent and error pages carry a Content Security Policy that blocks scripts
  and frames and limits form posts to atc and the client's redirect origin, and they refuse framing
  and caching. The error page shows a fixed sentence per error code, never text from the link, so a
  crafted link cannot put its own words on atc's origin.
- **Transport.** The server answers each MCP post with JSON and opens no server-to-client stream,
  and it refuses JSON-RPC batches and an MCP protocol version it does not speak, so a newer client
  falls back to initialize.

The server logs one line per request to stderr with the method, the path, the status, the time taken
and the MCP method and tool. A line never holds a request body, a query, a cookie or an address.
better-auth's telemetry stays off: atc sets its environment before better-auth starts, so a variable
the owner sets cannot turn it on.
