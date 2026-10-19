# Idempotent requests

A spawn or a message sent under an idempotency key takes effect at most once for that key. A caller
whose answer never arrived, because its connection or the daemon dropped, can resend the request
under the same key and get the first request's effect back instead of a second session or a second
message. When the daemon cannot tell whether the first request ran, it says so with
`outcome_unknown` rather than running it again, so a key never turns one intent into two effects.

[The protocol](./protocol.md) covers the connection, and [MCP](../remote/mcp.md#reconnecting) covers
the callers that resend under a key.

## Recording a key

The daemon holds each key per principal and method, so a principal's keys never collide with
another's, and the owner's requests hold their keys under the principal `local`. The owner's
connection may act as any principal, which is how `atc mcp --http` keeps each remote client's keys
under its client id.

The daemon records a key before it checks any param, together with a hash of the params as it parsed
them, in a canonical form without the key itself, so a default spelled out or a field the daemon
ignores leaves the hash unchanged. It also records the id it mints for the effect, the new session's
or the new message's, before the effect runs. A refused request drops the key again, so a retry runs
fresh. A key completes only after its effect is stored, so a completed spawn key always has a fleet
row behind it.

A retry of a key the daemon holds is answered from the key alone, without any param checked again:

- The same key with different params is `idempotency_conflict`.
- A completed spawn returns the session's current descriptor while it is listed, and the descriptor
  the first spawn returned after that.
- A completed message returns the message id with the message's current status.
- A request the daemon may or may not have run is `outcome_unknown`, with the effect's id in the
  error's data, and the daemon never runs it again under that key. The caller checks the session or
  message and retries under a new key.

## When the outcome is unknown

A spawn that fails after its process starts must take the process back before its key can be
dropped. The daemon kills the process, waits for it to exit, and writes the fleet without the
session; only then does it drop the key. A process that outlives the waits, or a fleet write that
fails, may leave the session standing, so the key stays `outcome_unknown` and the session stays
listed. The daemon refuses to revive that session while the first process may still run, so no
revived process runs beside it. A spawn whose process started but whose fleet write failed, and a
request whose key the daemon could not mark completed, get `outcome_unknown` too, with their effect
standing.

The daemon keeps a completed key for a fixed retention, which the handshake returns, and an
`outcome_unknown` key indefinitely. Clearing a held unknown key takes an operator, who looks for the
session whose id the error holds, kills it if it still runs and spawns again under a new key; no atc
command clears a key.

## After a crash

A daemon that stops mid-request leaves its key in progress. At start, before it serves a request,
the next daemon marks every such key `outcome_unknown`, then completes each one whose effect it can
see: a spawn key whose session is in the fleet, and a message key whose message row exists. A spawn
key completed this way has no stored answer, so a retry gets `no_such_session` with the effect's id
until a fleet restore lists the session, and the session's descriptor after that.

## Replay-only resends

A keyed request that also carries `replayOnly` never runs anything new. The daemon answers it from
the key exactly as it answers any retry, and a key it does not hold, never used or expired, gets
`idempotency_key_unknown` with nothing run. The flag is left out of the params hash, so a
replay-only resend matches the first send.

atc-gateway, which resends because the first answer never arrived, sends every resend as
replay-only, so a resend only ever replays. When the first send never reached the daemon, the resend
gets `idempotency_key_unknown`, and the request ends as `outcome_unknown`: the caller checks what
the daemon did instead of sending it again.

The MCP servers resend unchanged instead, without the flag. Each one reaches a daemon on its own
state directory through a local socket, and that daemon's claim on a key outlives any reconnect, so
an unchanged resend replays a key the daemon holds and runs once a request that never reached it
([MCP](../remote/mcp.md#reconnecting)).
