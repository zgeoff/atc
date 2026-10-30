# Principals

A request on the daemon's unix socket acts as the daemon's owner, who reaches every session. A
principal is a named caller with less: the config's `principals` key grants each principal a set of
targets, and a request that acts as a principal sees and touches only the sessions on those targets.
Every request on the TCP listener must act as a principal, so a remote client never acts as the
owner. `atc mcp --http` and atc-gateway act as the OAuth client that made each call
([MCP](../remote/mcp.md#remote-callers)).

A session on a remote host can hold atc access of its own, which its spawn grants and which reaches
only the session, the sessions below it and its parent
([a session's atc access](#a-sessions-atc-access)).

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

## A session's atc access

A spawn can grant the new session atc access: a set of the grant scopes `read`, `message`, `spawn`
and `kill`, which the [MCP servers](../remote/mcp.md#scopes) define. The session's guest then runs
an atc MCP server, and the daemon serves that server's requests as the session, with the session's
scopes and reach alone. A session without the grant gets no atc MCP server, and the daemon closes a
client connection from its host unanswered. The daemon holds the grant on the session and its fleet
row and never reads it from the guest, so the guest holds no secret, a restore brings the grant
back, and a host's sleep changes nothing.

The access reaches three sets of sessions, each read from the live fleet on every check, so a
session the holder spawns is in reach at once:

- The holder itself and the sessions below it: its sub-sessions and every session it or one of them
  spawned, at any depth. The daemon records which session sent each spawn, because a spawn from a
  sub-session lands beside it under the top-level parent, where the parent link alone would leave it
  out.
- For `kill`, the sessions below the holder alone, so the holder never stops or forgets itself or
  the host it runs on.
- For a message, the holder's parent too: its parent link, else the session that spawned it. The
  parent takes messages and nothing else.

A session out of reach answers as an unknown one does, as for a principal. Each request needs one
scope the holder holds, and the daemon refuses with `unauthorized` a request whose method needs a
scope the holder lacks, and every request that reads the daemon host's files or the whole fleet,
such as the recent directories, the sources, a fleet read or a restore. A request also fails once
the holder's harness has started again or moved, since the connection came from the harness that
held the bridge before.

A holder spawns only on its own target and identity, so a spawn without a target runs there and a
spawn to any other target fails with `target_forbidden`. A holder's spawn takes no workspace source,
because the daemon reads a source with its own host's files and credentials, which the holder's
access never reaches; the new session checks its work out itself. A holder's spawn resumes only an
agent session that a session in its reach holds, and names it, because the fleet keeps one row per
agent session on a target. Any other workspace or resume fails with `unauthorized`. A spawn grants
no scope its caller lacks:

- From a session with atc access, a scope the session does not hold is refused with `unauthorized`.
- From atc-gateway or `atc mcp --http`, the MCP server refuses a scope the bearer token lacks with
  `insufficient_scope`, since the daemon never sees a token's scopes.
- From the owner, any scope passes.

Every process inside one imp can open each bridge socket there, so a sub-session that shares its
parent's imp is refused a scope the parent lacks, and no process in an imp acts with more than the
imp's own session holds. A spawn with atc access to a target on the daemon's machine fails with
`bad_args`, because a session there reaches the daemon's own socket as its owner, which no grant can
narrow. Only an agent whose adapter can add the MCP server to its guest launch takes the grant, and
a spawn of any other agent with it fails with `bad_args` too.

## The TCP listener

A daemon started with `--listen` serves the client protocol on a TCP port as well as on its unix
socket, for a remote client such as atc-gateway. The protocol carries no TLS, so the listener relies
on the network for encryption: it binds only a loopback address or an address in the tailnet's
ranges, written as an IP literal, and refuses every other address and every host name. The
listener's bearer token is the gate, and it applies no source-address allow-list.

The token file holds one or two tokens, so a token can rotate without downtime. The daemon loads the
file only when the daemon's own user owns it and no other user can open it, because anyone who reads
a token can act as the listener's clients. The daemon compares digests of the presented token
against each one in constant time. A wrong or missing token gets `unauthorized` and a closed
connection, so a peer without a token learns neither the build nor the protocol version. Reloading
the file, on `SIGHUP`, closes every connection whose token the file no longer holds, so a removed
token stops working on open connections too. A reload of an invalid file fails closed: the daemon
drops every token and refuses every handshake until a reload succeeds.

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

A handshake that gives a principal may also bind a `viewer`, a second principal the config lists.
The connection's events and output then follow the reach that both principals share, for the
connection's whole life, and a request's `x-atc-as` header narrows that reach further but never
widens it. A daemon that takes a viewer lists `daemon.hello.viewer` among the features its hello
answer holds, and a client that binds a viewer refuses a daemon whose answer lacks it. When a
session leaves the shared reach, the daemon drops the session's events and output that the
connection has not yet sent, then queues the removal, so nothing of the session reaches the client
after the removal.
