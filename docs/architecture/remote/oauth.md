# OAuth

`atc mcp --http` runs an OAuth 2.1 authorization server in its own process, so a hosted assistant
can reach the fleet with a grant the owner approved. The server is single-user by construction: only
clients the owner added by hand can start an authorization, and every authorization needs a fresh
sign-in with one of the owner's passkeys, bound to that one request. better-auth's OAuth provider
runs the protocol, and atc adds the parts that make it single-user. atc-gateway runs the same server
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
file holds clients, consent, short-lived owner sessions, the owner's passkeys as credential ids and
public keys, and hashes of enrollment tokens, access tokens, refresh tokens and authorization codes,
never one of those tokens in the clear.

Pending approvals and their WebAuthn challenges live in memory, and the server signs each
authorization request and owner session with a secret it draws at start. Restarting the server
therefore ends the approvals and sign-ins in progress, and the grants survive.

## Who does what

better-auth runs the protocol: request validation at the authorization endpoint (client, exact
redirect URI, scopes, PKCE and the resource indicator), authorization codes, opaque access tokens,
rotating refresh tokens with reuse detection, revocation, and the two metadata documents. atc adds
the owner and everything around the protocol: the passkeys, the sign-in, enrollment and consent
pages, the parameters it sets on every authorization request, the bearer check on the MCP endpoint
and the per-tool grant scope check, the route list, and the request checks below.

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
3. **Passkey sign-in.** A valid request gets a pending approval and the sign-in page, which shows
   the client and its full redirect URI. Each page shown mints a fresh WebAuthn challenge for that
   one request, replacing the last, and a posted assertion takes the challenge whether or not it
   verifies, so an assertion counts at most once and only for the request whose page asked for it.
   An assertion signs the owner in only when it comes from an enrolled passkey, verifies against
   that passkey's public key for the server's origin and RP ID, reports a verified user, and carries
   a signature counter past the stored one when the authenticator keeps one. The server bounds
   failed sign-ins per request, waiting approvals per client and in total, and approval starts per
   minute.
4. **Consent.** The consent page requires the session the passkey signed in, for the request it
   approved: the same client, redirect URI, scopes, resource, state and PKCE challenge. The page
   lists the scopes the client asked for with only `read` ticked to start. Either answer ends the
   session's binding, so one sign-in approves exactly one authorization.
5. **Token exchange.** The client exchanges the code once, with the same client id and redirect URI
   and a verifier that matches its PKCE challenge. A second exchange of the same code fails and
   revokes the tokens the first produced.

## Passkeys

The owner is the one user, and a passkey is the only credential that signs the owner in. The RP ID
is the public origin's host name, so a passkey works only at the origin it was enrolled at, and a
browser refuses one on an IP address. Each passkey is discoverable and requires user verification,
and atc asks for no attestation: it trusts a new passkey through the enrollment token it came with,
not through the device that made it.

Enrollment starts on the host. `atc passkeys enroll`, or `atc-gateway passkeys enroll` for a
gateway, opens `mcp-auth.db` and writes the hash of a fresh random token that expires soon after.
The owner types the token on the enrollment page, which mints a challenge bound to that token, and
the registration that verifies against the challenge stores the passkey and spends the token in one
transaction, so one token enrolls one passkey. Enrolling signs nobody in. No route adds, removes or
resets a passkey without a token, and an installation with no passkey refuses every sign-in rather
than letting the first visitor claim it.

More than one passkey may be enrolled, so a second device covers a lost one. Removing a passkey, or
the reset that `--reset` runs before it prints a new token, deletes every owner session, and a reset
deletes every unused token too, so neither a lost authenticator nor an earlier token still works.
Grants and their tokens survive both. A sign-in whose assertion verified just before a removal
commits creates its session after the deletes ran. So once the session exists, the server checks in
one transaction that the signing passkey is still enrolled, and deletes the session when it is not.
Whichever commits first, no session outlives the removal. Recovery has no remote path: the trust
boundary is write access to `mcp-auth.db`, which the file mode keeps to the user who runs the
server, and anyone with that access can enroll a passkey.

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
- **Origin.** A form post to the sign-in, enrollment or consent page must come from the public
  origin or the local address, and so must an MCP request that carries an `Origin` header.
- **Pages.** The sign-in, enrollment, consent and error pages carry a Content Security Policy that
  limits form posts to atc and the client's redirect origin and refuses framing, and they refuse
  caching. The policy blocks every script except, on the sign-in and enrollment pages, the one
  passkey script atc serves, which it allows by hash. The error page shows a fixed sentence per
  error code, never text from the link, so a crafted link cannot put its own words on atc's origin.
- **Transport.** The server answers each MCP post with JSON and opens no server-to-client stream,
  and it refuses JSON-RPC batches and an MCP protocol version it does not speak, so a newer client
  falls back to initialize.

The server logs one line per request to stderr with the method, the path, the status, the time taken
and the MCP method and tool. A line never holds a request body, a query, a cookie or an address.
better-auth's telemetry stays off: atc sets its environment before better-auth starts, so a variable
the owner sets cannot turn it on.

## Security events

Each sign-in outcome writes one line to stderr: `atc security ` followed by a JSON object. A log
shipper matches that prefix. No line the server writes, on stdout or stderr, holds a value that
signs in. The events come from the shared server code, so `atc mcp --http` and `atc-gateway serve`
write the same lines, and atc holds no delivery credential: sign-in never waits on an alert.

| `kind`              | `outcome`              | `reason`                                                                        |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `authorize_started` | `accepted`, `rejected` | `rate_limited` when the limit on approval starts refused it                     |
| `authorize_invalid` | `rejected`             | better-auth's error code from a fixed list, `bad_host`, `bad_origin` or `other` |
| `owner_auth`        | `succeeded`, `failed`  | `assertion_failed`, `locked`, `expired`, `not_enrolled` or `invalid_token`      |
| `consent`           | `allowed`, `denied`    | `none_ticked` when allow came with no scope ticked                              |
| `suppressed`        | none                   | the kind the burst cap dropped, with the dropped `count`                        |

A consent is `allowed` only when the answer issued an authorization code. The Host and origin checks
under [request checks](#request-checks) write `authorize_invalid` for every route they refuse, and
an `owner_auth` event comes only from a posted sign-in or enrollment, never from showing a page. An
enrollment writes `owner_auth` with route `/enroll`: `succeeded` once the passkey is stored, and
`invalid_token` for a token the database does not hold unexpired.

An accepted start mints a random correlation id with its pending approval. The passkey sign-in
carries it to the owner session it starts, and the consent event repeats it, so one authorization's
events can be joined. The id never derives from the challenge, the signed query, the state or the
PKCE values.

The line holds only the fields of the security-event contract, and the formatter picks each one by
name, so a value added to an event never reaches the line by accident:

- `v`, `ts`, `kind`, `outcome` and `reason`, with `method` on `owner_auth`: `passkey` for a sign-in
  and `enrollment_token` for an enrollment.
- `route`: the request's path when it is one atc serves, else `other`, and never a query.
- `client` with its id and name, only for a client atc holds, and `redirectHost` only once
  better-auth validated the redirect URI.
- `peer`, the socket's address with provenance `socket`, and `forwarded`, the `CF-Connecting-IP`
  header with provenance `unverified`, since anyone can send that header.
- `userAgent`, cut short, with provenance `client`.

Every string from the client loses its control and format characters and is cut to a bound. No line
holds an authorization code, an enrollment token, a WebAuthn challenge or credential, a token, a
cookie, an `Authorization` header, a body, a signed query, the state, PKCE material or a URL with a
query.

A burst cap bounds each kind per window, so a flood of bad requests cannot flood the journal. Past
the cap the log drops events and counts them, and when the window ends it writes one `suppressed`
event with the count. The window's end is scheduled when its first event drops, so the count arrives
even when no further request comes, and stopping the server writes any count still pending.
