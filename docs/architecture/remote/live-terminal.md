# Live terminals

`atc mcp --http` streams a session's terminal to a browser over a WebSocket at
`/sessions/<session_id>/pty`, behind the same OAuth as its MCP tools. The stream is watch-only: the
browser sees the screen and every byte the agent prints, and it never types, resizes, or counts
toward the session's size. Each daemon's own server streams only that daemon's sessions, and a token
one server issued opens nothing on another.

A viewer is a [watcher](../daemon/terminals.md#watching) on a daemon connection of its own. The
server opens that connection as the caller's principal, so the daemon decides what the viewer may
see, exactly as it does for a tool call. A viewer that falls behind loses output rather than slowing
the session, and it catches up from a fresh snapshot.

The [remote MCP guide](../../guides/remote-mcp.md#watching-a-terminal-in-a-browser) covers serving a
viewer page, and [`live-terminal.html`](../../guides/live-terminal.html) is a working page.

## Opening the socket

A browser cannot set an `Authorization` header on a WebSocket, so the page offers its bearer token
as a subprotocol. The page offers two subprotocols:

- `atc.pty.v1`, the frame format in [Frames](#frames). The server selects it in its answer.
- `atc.bearer.<token>`, where `<token>` is the bearer token in unpadded base64url, because a
  subprotocol takes no `+`, `/` or `=`.

```js
new WebSocket('wss://mcp.example.com/sessions/s-7f3a/pty', ['atc.pty.v1', 'atc.bearer.dG9rZW4']);
```

The server accepts two kinds of bearer token:

- **An OAuth access token** with the `read` scope, which the client got through
  [the OAuth flow](./oauth.md#connecting-a-client). The viewer acts as the client's principal, so it
  opens only a session that principal reaches ([principals](../protocol/principals.md)). While the
  stream is open, the server checks on a timer that the client still holds a grant with `read`, and
  it ends the stream when two checks in a row find none, because a refresh replaces a grant's token
  in two writes.
- **An owner token** from the file `--token-file` names, which acts as the daemon's owner and opens
  every session. The file holds one token per line, and the server reads it once at startup. The
  server refuses to start when other users can open the file, and when it binds an address beyond
  loopback, because an owner token over the network would bypass the passkey that guards every OAuth
  grant.

## Request checks

The server makes every check before it upgrades the request, so a refused page never holds a socket.
A refusal answers with an HTTP status and no body:

| Status | When                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| 400    | the session id in the path holds a percent escape that decodes to no text                     |
| 403    | the `Host` header is not the public origin, the local address or an allowed host              |
| 426    | the request asks for no WebSocket upgrade                                                     |
| 403    | the `Origin` header is not on the allowed list                                                |
| 400    | the request offers no `atc.pty.v1` subprotocol                                                |
| 401    | the request offers no bearer subprotocol, or a token that is neither an owner token nor valid |
| 403    | the OAuth token lacks the `read` scope                                                        |
| 404    | the session does not exist, or the caller's principal cannot see it                           |
| 409    | the session has exited                                                                        |
| 503    | the server has no daemon connection                                                           |

The allowed origins come from `--allowed-origin` and the `mcpHTTP.allowedOrigins` config. A request
with no `Origin` header comes from no browser page, such as a script, so only its token gates it. A
refused host, origin or token records a security event, as an MCP request does
([security events](./oauth.md#security-events)).

## Frames

The server sends two kinds of frame, and the browser sends none that the server reads. A binary
frame holds terminal output: the bytes the agent printed, in order, ready for a terminal emulator to
write. A text frame holds one JSON control object, whose `type` field names it:

| `type`     | Fields                                 | Meaning                                                                                       |
| ---------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `snapshot` | `cols`, `rows`, `seq`, `state`, `data` | the whole screen as a replay in `data`; reset the terminal to `cols` by `rows`, then write it |
| `resize`   | `cols`, `rows`                         | the session's size changed; resize the terminal                                               |
| `state`    | `state`                                | the session's state changed, such as to `needs_you`                                           |
| `closed`   | `reason`                               | the stream ended, and the server closes the socket next                                       |

The first frame is a snapshot. One exception: when the stream ends before the browser's socket
opens, such as when the session exits or the daemon connection drops in between, the only frame is a
`closed` frame. Every binary frame after a snapshot continues that snapshot's screen with no gap and
no repeat, so a page that resets on each snapshot and writes each binary frame shows the session's
screen. `seq` is the sequence number of the last output the snapshot holds; a page needs it only to
log or compare.

A `closed` frame's `reason` is one of:

- `exited`: the session's agent exited.
- `removed`: the owner forgot the session.
- `daemon_closed`: the viewer's daemon connection ended, such as when the daemon stops.
- `unavailable`: the server could not take a fresh snapshot.
- `revoked`: the OAuth client no longer holds a grant with `read`.

After a `closed` frame, the server closes the socket with the normal closure code and the reason as
its close reason.

## Slow viewers and reconnecting

A viewer never holds back the session or another client. The server writes each output frame to the
socket only while the socket holds less than its buffer limit. Past that limit the viewer stops
sending output and drops what arrives. Once the browser reads enough for the socket to drain, the
viewer asks the daemon for a fresh watch and sends its snapshot, which replaces everything the
viewer dropped. The viewer takes a fresh snapshot the same way when the daemon reports dropped
output on the viewer's connection, or when an output's sequence number skips one.

A page that loses its socket opens a new one. The server keeps no state for a closed viewer and
replays nothing from before the new socket opened: the new socket starts with a fresh snapshot.
