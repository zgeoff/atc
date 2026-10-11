# The client protocol

Every atc client talks to the daemon in one dialect: newline-delimited JSON, one object per line, in
UTF-8, over the daemon's unix socket or its TCP listener. A connection opens with a handshake, then
carries requests, one answer per request, and unsolicited events. Client and daemon ship from one
repo and must speak the same protocol version, and inside one version the daemon lists the features
it serves, so the protocol grows by addition and a peer never breaks on a field it does not know.

[Principals](./principals.md) covers who a request acts as, [idempotency](./idempotency.md) covers
retrying a spawn or a message, [messages](./messages.md) covers the inbox, and [events](./events.md)
covers the event trail and the events socket.

## Why JSON lines

The protocol has no binary frame. The pseudo-terminal library delivers output as decoded strings, so
byte-level transparency is gone before the protocol sees the data, and binary framing would buy size
but no fidelity. One dialect also serves every peer: the session helpers, the MCP tools and the
Agent SDK all speak JSON already.

## Messages

A line is one of three kinds, told apart by its fields:

```jsonc
// request (client to daemon): the client numbers its requests
{ "v": 4, "id": 7, "m": "session.spawn", "p": { "cwd": "/x", "name": "auth-bug" } }

// answer (daemon to client): exactly one per request
{ "v": 4, "id": 7, "ok": { "session": "s7-m4x2p" } }
{ "v": 4, "id": 7, "err": { "code": "no_such_session", "msg": "…" } }

// event (daemon to client): unsolicited, never acknowledged
{ "v": 4, "ev": "SessionOutput", "s": "s7-m4x2p", "seq": 41, "d": "…" }
```

Every line carries the protocol version, so a tap on the socket can read any line alone. Methods are
named `noun.verb` and events `PascalCase`, which the MCP tools map onto mechanically. The protocol
module's request schemas define every method and its params, and its error list defines every code.

The daemon runs each request on its own, so answers can arrive in another order than their requests,
and a client matches each answer to its request by id. A state-changing request always gets an
answer, but a client need not wait for one, as the TUI does not for keystrokes: one socket carries
one ordered stream, so input, resize and output stay in order by construction.

## Errors

An error holds a code from a closed list that grows by addition, a human message, and optional
`data` whose fields the code defines. The rules exist so additive evolution never breaks a peer:

- An unknown method is an `unknown_method` error, never a disconnect.
- Every field a peer does not know is ignored, in any message.
- A peer decodes an error code it does not know as `internal` and keeps the message.

A malformed line or one longer than the line cap means a buggy or hostile peer, since the transport
guarantees byte integrity, so the daemon closes the connection with an error rather than scanning
for the next good line. The daemon enforces the cap before it buffers a line.

## The handshake

The first line on a connection must be `daemon.hello`, and the daemon answers nothing else before it
and holds back every other answer until the handshake answer is written. The hello carries the
client's build and its credential, which is `none` on the unix socket and a bearer token on the TCP
listener ([principals](./principals.md#the-tcp-listener)). A client started inside a session also
sends that session's id, which the daemon uses to stop a session from widening its own record
([session record](../execution/session-record.md#who-may-change-the-record)).

The answer holds the daemon's build, its feature list, its line limits, how long it keeps a
completed idempotency key, the last agent the owner spawned, and the daemon id. The daemon mints
that id into its store the first time it opens it, so the id stays the same across restarts, and
every session descriptor holds a locator of the daemon id and the session's target, which tells a
client routing across several daemons where a session lives.

## Versions and features

The protocol version is one integer compared for equality. A daemon on another version refuses the
handshake with `protocol_mismatch`, and the error holds both versions and both builds, so the
failure says what to do. [The daemon](../daemon/daemon.md#builds-and-protocol-versions) covers how
each client handles it.

Inside one version, the daemon's feature list names each request feature it serves beyond the
version's base: a method that exists, a param it takes, a field its answer holds. A client that
outlives a daemon upgrade, such as an MCP server, reads the list rather than the build string to
learn what the running daemon honours. The MCP servers hide a tool or an input that the connected
daemon lacks, and refuse a call that needs one with `daemon_outdated` without sending it on. A
daemon ignores a param it does not know, so a client that sends one to an older daemon gets the old
behaviour, never an error.

## Events

The daemon broadcasts lifecycle and state events to every connection: sessions added, removed,
renamed and resized, state changes, attaches and detaches, notes, message status changes, and
permission prompts. Each event that concerns a session carries the full session descriptor, the same
shape a session listing returns, so a client decodes every event through one path. Two kinds of
event go to one connection alone: a session's output goes only to the clients attached to it, and
inbox events go only to the session's message tap ([messages](./messages.md#the-tap)). A connection
that acts as a principal receives only the events of sessions within its reach.

A permission prompt broadcasts with a flag that says whether a client can answer it through the
protocol. Every prompt from a terminal session carries false, because the agent takes its answer as
keys in its terminal. A session that takes a structured answer raises the same event with the flag
set, and the first answer wins: it broadcasts the resolution, so every client dismisses its prompt,
and later answers get `already_answered`.

## Connection lifecycle

Every change to the fleet is an explicit request: detach, kill, quit. The daemon never infers one
from a connection closing, and a dropped connection means only that the daemon detaches that
connection's attachments and its message tap. A client whose connection drops rejects every request
still waiting for an answer, and decides for itself whether to resend it.
