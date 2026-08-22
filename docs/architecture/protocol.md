# Wire protocol

The daemon/client protocol: newline-delimited JSON (NDJSON) over a unix socket, one JSON object per
line, UTF-8. No binary frame class. This was decided against a hybrid JSON-control / binary-data
design on measured evidence:

- `bun-pty` delivers PTY output as decoded JS strings (streaming TextDecoder inside the library), so
  byte-level transparency is already gone before the protocol sees the data — binary framing would
  buy size, not fidelity.
- JSON string escaping of an ANSI-heavy full-screen repaint measures ~1.27x expansion (1.02x on
  plain text), and encode+parse costs ~0.1–0.2% of one core at a 1 MB/s worst case. The tmux
  control-mode ~4x tax comes from octal-escaping every control byte, which JSON does not do.
- One parser, one id space, one socket dialect: the hook and statusline reporters already speak
  NDJSON to the daemon socket, SDK agent sessions emit JSON natively, and the future MCP tools are a
  field-rename away from the control envelope.

Revisit trigger: if the PTY layer is ever replaced with a byte-level provider, transparency returns
and a base64 or binary data path earns reconsideration. Until then it is a cost with no benefit.

## Envelope

Three message kinds, distinguished by which fields are present. Every line carries `v` (protocol
version) so a socket tap can interpret lines standalone.

```jsonc
// request  (client -> daemon); id is client-assigned, monotonic per connection
{ "v": 2, "id": 7, "m": "session.spawn", "p": { "cwd": "/x", "name": "auth-bug" } }

// response (daemon -> client); exactly one per request
{ "v": 2, "id": 7, "ok": { "session": "s7-m4x2p" } }
{ "v": 2, "id": 7, "err": { "code": "no_such_session", "msg": "…" } }

// event    (daemon -> client, unsolicited, never acknowledged)
{ "v": 2, "ev": "session.output", "s": "s7-m4x2p", "seq": 41, "d": "[1mhello[0m" }
```

Methods are `noun.verb`; the future MCP tools map onto them mechanically (`session.spawn` → tool
`atc_session_spawn`, events → notifications). Error codes are human-readable strings from a closed,
extendable set: `protocol_mismatch`, `unauthorized`, `unknown_method`, `bad_args`,
`no_such_session`, `session_dead`, `unsupported`, `already_answered`, `too_slow`, `internal`. An
unknown method is an `unknown_method` error, never a disconnect; unknown fields in any message are
ignored. Both rules exist so additive evolution never breaks a peer.

## Handshake

The first line on a connection must be `daemon.hello`; the daemon answers nothing else before it.
Versioning is a single integer with strict equality — daemon and client ship from the same repo, so
the only mismatch that happens in practice is a long-running daemon outliving an upgrade. The
failure must be actionable, not cryptic: the error names both versions and both build strings and
says to restart the daemon.

```jsonc
{ "v": 2, "id": 1, "m": "daemon.hello",
  "p": { "client": "atc/0.4.0", "auth": { "scheme": "none" } } }

{ "v": 2, "id": 1, "ok": { "daemon": "atc/0.4.0",
                           "limits": { "maxLine": 1048576, "maxChunk": 65536 },
                           "lastUsedAgent": "claude" } }
```

`lastUsedAgent` is the agent of the last deliberate spawn that reported SessionStart (`claude`,
`grok`, or `codex`). A spawn that never reports SessionStart does not change it. A fleet restore
SessionStart does not change it. MCP spawn ignores the value and defaults to Claude.

`auth` is present from day one (`{"scheme": "none"}` on the unix socket) so a TCP or SSH transport
later adds a scheme, not a handshake redesign. The transport is assumed to be an ordered, reliable
byte stream and nothing more — no unix-socket peer credentials or filesystem paths in message
semantics.

## Methods

| Method                  | Purpose                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon.hello`          | handshake; must be first. The ok includes `lastUsedAgent` (`claude`, `grok`, or `codex`), written on a deliberate-spawn SessionStart. |
| `daemon.ping`           | liveness / latency probe                                                                                                              |
| `daemon.quit`           | stop the daemon; every hosted session goes down with it                                                                               |
| `session.list`          | fleet listing (descriptors mirror the `Session` shape, minus the PTY handle, plus `kind` and `agent`)                                 |
| `dirs.list`             | recent spawn directories, most recent first, for the picker                                                                           |
| `fleet.list`            | the persisted fleet rows, independent of which sessions are currently live                                                            |
| `session.spawn`         | spawn (cwd, name, prompt, resume, dims, optional `agent`). Omitted `agent` is Claude. Unknown is `bad_args`.                          |
| `session.update`        | rename and/or pin a session (`{ session, name?, pinned? }`)                                                                           |
| `session.kill`          | kill process; explicit, never implied by disconnect                                                                                   |
| `session.ack`           | clear unread without attaching                                                                                                        |
| `session.attach`        | subscribe to a session's output; returns replay + current dims                                                                        |
| `session.detach`        | unsubscribe; session keeps running                                                                                                    |
| `session.input`         | keyboard input to a session (`{ session, d }`)                                                                                        |
| `session.resize`        | client reports its dims; effective size is the min across attached clients (broadcast as `session.resized`)                           |
| `session.resumeCommand` | build the resume command for that session's agent (`claude --resume`, `grok --resume`, or `codex resume`)                             |
| `session.eject`         | hand a live session off to a headless run so it keeps working unattended                                                              |
| `session.adopt`         | bring a dead or headless session back onto a live terminal                                                                            |
| `fleet.restore`         | cold-boot recovery: respawn the persisted fleet                                                                                       |
| `permission.respond`    | answer a permission request (`{ request, decision }`)                                                                                 |

`session.input` is a request (it gets an ok, preserving the rule that state-changing messages are
acknowledged) but clients need not await it — measured cost of the JSON round trip is ~0.2µs against
a ~3µs socket round trip. Ordering between input, resize, and output is guaranteed by construction:
one socket, one ordered stream.

Multi-client rules, chosen to cover the realistic conflicts without a write-lock protocol:

- Input atomicity: a client sends one complete key event or one complete paste per `session.input`;
  the daemon writes each input payload to the PTY whole, never interleaving bytes from two clients
  inside one payload. Client input is decoded statefully per client so a multi-byte character split
  across reads is never mangled.
- Resize debounce: the daemon debounces effective-dimension changes (~50ms) and suppresses PTY
  resizes when the effective size is unchanged, so two clients resizing in opposite directions
  cannot produce a SIGWINCH storm.

## Events

`session.added`, `session.state`, `session.renamed`, `session.removed`, `session.resized`,
`session.output`, `session.desync`, `permission.requested`, `permission.resolved`.

State/lifecycle events broadcast to every client (every overlay needs them). `session.output` goes
only to clients attached to that session — an unfocused session costs a client zero bytes. Output
events carry a per-session `seq` so a client can detect gaps.

## Attach and streaming

The daemon reads every PTY continuously — background output is consumed, not discarded — and feeds
it to the per-session screen model. On attach, the daemon sends the current screen state (serialized
from the screen model) as ordinary `session.output` events, then live output behind it; the client
cannot tell replay from live and does not need to. Before the screen model exists, attach falls back
to the resize-jiggle repaint: correct, slower, flickers.

Sessions have a `kind`: `pty` (output is terminal text) or `headless` (output is structured agent
messages, e.g. SDK sessions). Same attach flow, same events, different payload discipline — this is
one field now instead of a protocol version later.

## Backpressure

The invariant: a slow client never stalls the PTY reader or any other client. Delivery policy — not
serialization — is where output and control genuinely differ:

- Every client has a bounded outbound queue (~2 MiB). Bun's `socket.write()` returns bytes-accepted
  and drops the rest silently, so short-write handling with a `drain`-driven flush is mandatory, not
  optional; an early loss test (blast a slow reader, assert zero loss) guards it.
- Output is droppable: if a client's queued output for a session overflows, the daemon discards that
  session's backlog, emits `session.desync` (with dropped byte count), and resynchronizes the screen
  when the queue drains — a full repaint from the screen model, or the jiggle before it exists. A
  lagging client wants current state, not the backlog it missed. Intermediate ANSI chunks are never
  dropped without a resync, because a byte stream cut mid-escape corrupts the client's terminal
  state.
- Control is not droppable: a control-queue overflow is a bug or a hostile peer — disconnect.
- `headless` sessions never drop-and-resync (structured messages are semantic, not idempotent screen
  state): their queue is bounded and overflow fails the attach with `too_slow`. The transcript on
  disk is the durable copy; the socket is not a durability layer.

## Permissions

`permission.requested` broadcasts to all clients with a `respondable` flag. Today it is synthesized
from the Claude Code `Notification` hook and carries `respondable: false` (a PTY session is answered
with keystrokes); when SDK sessions land, the same event arrives with `respondable: true` and
`permission.respond` starts working — clients built today already have the right shape. Arbitration
is first-response-wins: the first `permission.respond` gets `ok`, the resolution broadcasts as
`permission.resolved` so every client dismisses its prompt, and later responders get
`already_answered`. A request times out to deny; a client disconnecting never resolves a request by
itself.

## Limits and violations

Line length is capped (1 MiB control, 64 KiB output chunks — the daemon splits larger PTY reads) and
enforced before buffering. The output-chunk cap also bounds head-of-line blocking: control and
output share one ordered socket by design (ordering by construction beats a second connection's
lifecycle and auth complexity), and a queued response can be delayed by at most one chunk. If that
ever hurts over a high-latency tunnel, the designed escape hatch is a resumption token in the
handshake result that lets a second data-only connection join the same client session — additive, no
framing change. There is no resync-by-scanning: transports guarantee byte integrity, so a malformed
line or oversized frame means a buggy or hostile peer, and the connection closes with a clear error.
Lifecycle is always explicit protocol messages — detach, kill, shutdown — never inferred from socket
half-close; a dropped connection implies only detach-all for that client's subscriptions.
