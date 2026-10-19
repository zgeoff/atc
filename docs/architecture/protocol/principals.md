# Principals

A request on the daemon's unix socket acts as the daemon's owner, who reaches every session. A
principal is a named caller with less: the config's `principals` key grants each principal a set of
targets, and a request that acts as a principal sees and touches only the sessions on those targets.
Every request on the TCP listener must act as a principal, so a remote client never acts as the
owner. `atc mcp --http` and atc-gateway act as the OAuth client that made each call
([MCP](../remote/mcp.md#remote-callers)).

[The protocol](./protocol.md) covers the connection and its handshake, and the
[configuration guide](../../guides/configuration/principals.md) covers setting the grants.

## Acting as a principal

A request acts as a principal when its `x-atc-as` header holds one, and its `x-atc-as-name` header
holds that principal's display name. A whole connection acts as one when its handshake holds
`principal`. A request with neither acts as the owner. A request's principal can only narrow its
connection's: on a connection that acts as one principal, a request that acts as another reaches
only the targets both may use. The daemon refuses a request whose `x-atc-as` header is empty or
repeated with `bad_args` rather than ignore the value, because ignoring it would leave the request
with the connection's full reach.

## Who a caller is

The daemon tells four callers apart, and labels each message with the one that sent it
([messages](./messages.md#who-a-message-is-from)):

- A connector is a principal: an OAuth client that atc-gateway or `atc mcp --http` vouches for. A
  connector is never an atc session.
- A session is the owner plus a session binding. On the local socket the kernel's answer for the
  connecting process sets the binding, else the session the handshake gives
  ([the protocol](./protocol.md)).
- The owner is an atc client with neither a principal nor a session binding: its handshake gives an
  atc build as its client name, as the TUI, the CLI and `atc mcp` do.
- A local program is any other caller with neither a principal nor a session binding, such as a
  scheduled job or a helper tool. It is named by the `from` its request gives, else by the client
  name its handshake gives.

The owner and a local program both run as the owner's user outside every session, so the kernel
cannot tell them apart. The daemon therefore grants the owner label only to a client that claims an
atc build, because an agent reads that label as the owner's own word, and a program that never
claims it can never speak as the owner by accident. The claim is no credential: a program that sends
an atc build reads as the owner, as any program of the owner's user could act as the owner anyway.

A request that acts as a principal carries the principal's name in `x-atc-as-name`, beside
`x-atc-as`, and the daemon trusts the name on the same basis as the principal: the TCP listener's
token, or the owner's local socket. A connection whose handshake gives a principal has no name for
it, so its messages carry the principal for a name. The kernel's session binding wins over
`x-atc-as`, because a process inside a session that sends a principal and a name would otherwise
label its message as any connector. The daemon refuses a request whose `x-atc-as-name` comes without
`x-atc-as` or is empty or repeated.

## Reach

Each grant matches a target's name and its identity together, so a target whose config changes
leaves every grant that named its old identity. A session is within a principal's reach when every
session in its tree, the top-level session and each of its sub-sessions, runs on a target and bound
identity the principal's grants match. To a principal, a session out of reach does not exist:

- Listings, fleet reads and event reads leave it out.
- Every request that holds its id, or the id of one of its messages or notes, gets the same refusal,
  code, message and data that an unknown id gets.
- A spawn under a parent out of reach is refused as a spawn under an unknown parent, and a spawn to
  a target the principal may not use fails with `target_forbidden`.
- The listing of agents and targets holds only the targets the principal may use.

Reach can change while a session lives, such as when a parent gains a sub-session on a target the
principal may not use. A principal connection is then pushed a removal for that session, as for a
forgotten one, and loses its output and its message tap. A tree that comes back within reach is
pushed as added, such as a parent whose sub-session on that target is detached. A request checks
reach again after each of its waits, before it answers or acts, so a session that leaves reach
during a long poll or a spawn answers as one the daemon never held.

Events, messages and notes belong to the atc session they were recorded under. A session within
reach that resumes the same agent session as one out of reach never shows the other's events,
messages or activity.

Four requests act on the whole daemon or on a host's credentials rather than on one session: quit,
fleet restore, and the two runtime auth requests. A principal gets `unauthorized` for each. The
events socket has no handshake and streams every event, so it is a local socket for the owner alone.

## The TCP listener

A daemon started with `--listen` serves the client protocol on a TCP port as well as on its unix
socket, for a remote client such as atc-gateway. The protocol carries no TLS, so the listener relies
on the network for encryption: it binds only a loopback address or an address in the tailnet's
ranges, written as an IP literal, and refuses every other address and every host name. The
listener's bearer token is the gate, and it applies no source-address allow-list.

The token file holds one or two tokens, so a token can rotate without downtime. The daemon compares
digests of the presented token against each one in constant time. A wrong or missing token gets
`unauthorized` and a closed connection, so a peer without a token learns neither the build nor the
protocol version. Reloading the file, on `SIGHUP`, closes every connection whose token the file no
longer holds, so a removed token stops working on open connections too. A reload of an invalid file
fails closed: the daemon drops every token and refuses every handshake until a reload succeeds.

Until its handshake passes, a TCP connection gets nothing but the answer to that one handshake. Any
other line, a malformed or oversized one, or a second line sent while the handshake is still being
checked closes the connection with no reply and counts as a failed handshake. A source address that
fails several handshakes in a short window waits before its next one is checked, and the daemon
bounds how many such waits run at once, refusing the overflow at once. After the handshake, a second
hello gets `unauthorized`, so a connection never changes its principal.

On a TCP connection the two fields do different jobs. The handshake's `principal` decides which
events the connection receives: a TCP connection starts with no reach at all, so it receives no
event of any session until its handshake gives a principal. Every request must still carry an
`x-atc-as` header with a principal the config lists, and a request without one gets `unauthorized`.
One exception: the event subscription needs no `x-atc-as` header, because it delivers only what the
connection's own reach admits. The listener logs each refusal to stderr as one line for a journal
alert to match, and the [gateway guide](../../guides/gateway.md#the-daemon-listener) covers the
lines and the token rotation steps. No line holds a token or any part of one, and the listener's
writes to stderr never block the daemon.
