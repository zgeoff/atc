# The daemon

The daemon is the one long-lived atc process. It hosts every session, holds the state store, and
serves every client. Exactly one daemon runs per state directory, and every client finds it, or
boots it, through the same startup check. A client never stops a running daemon on its own, because
stopping the daemon ends every local session it hosts.

[Sessions](./sessions.md) covers what the daemon hosts, [terminals](./terminals.md) covers how it
streams them, and [restart](./restart.md) covers replacing a running daemon on purpose.

## One daemon per state directory

A daemon takes an exclusive kernel `flock` on a lock file in its state directory before it opens the
store, binds a socket or restores a session. Two daemons started in the same instant therefore
cannot both start, and a crashed daemon never blocks the next one, because the kernel drops the lock
with its process. The lock descriptor closes on exec, so an agent process the daemon started never
holds it. A daemon that finds the lock held waits briefly for a daemon that is shutting down, then
exits with an error that holds the holder's pid and socket.

The lock file is never removed. A newcomer could otherwise lock a fresh file at the same path while
the old daemon still holds the removed one, and two daemons would run.

The lock follows the state directory, while socket paths follow `$XDG_RUNTIME_DIR`, and a process
whose environment lacks that variable, such as an MCP server inside a sandbox, computes its socket
paths under the state directory instead. Once it holds the lock, the daemon therefore writes a
record beside it, `daemon.json`, with its pid, its socket paths and the port of its TCP listener. A
client that finds no daemon at its own socket path reads that record and tries the socket it holds
before it boots anything.

## Startup

A daemon starts in a fixed order, so no client ever sees a half-started daemon:

1. It takes the lock and writes its record.
2. It opens the store and settles what a stopped daemon left unfinished: idempotency keys still in
   progress and workspaces short of ready ([idempotency](../protocol/idempotency.md#after-a-crash)).
3. It binds the TCP listener, when one is configured, before the unix sockets. A bind that fails
   refuses the start before any client connects, and releases the lock.
4. It binds its unix sockets, unlinking any socket file a crashed daemon left behind.
5. It restores the stored fleet, unless the config turns that off
   ([fleet and restore](./fleet-and-restore.md#restoring-the-fleet)).

## Who boots the daemon

Every client that needs a daemon runs one startup check: the TUI, `atc mcp` and `atc mcp --http`. It
tries the computed socket, then the socket in the daemon record. When neither answers, it starts
`atc daemon` detached and waits for it to answer. Overlapping boots inside one process share one
start, and a boot that lost the lock to a daemon still shutting down starts again.

An installed `atc-daemon.service` user unit reserves daemon startup for systemd, whatever state the
unit is in. A client that finds the unit file waits for the daemon without a deadline and starts
none, so two daemons never compete for one state directory. The check reads the unit search
directories rather than asking systemd, so it holds while the service manager is unreachable.
`atc mcp --http --wait-for-daemon` makes the same choice for one process: it waits for a daemon,
then exits, so a service manager restarts it.

## Builds and protocol versions

Client and daemon ship from one repo, so the only version mismatch in practice is a daemon that
outlives an upgrade. A daemon from another build on the same protocol version stays in service, and
the TUI marks it `⟳ update ready` until the owner restarts it. A daemon on another protocol version
refuses the handshake, so the client cannot ask it anything, including whether it hosts live
sessions:

- A non-interactive client, such as `atc mcp`, exits with an error that holds both builds, both
  protocol versions, the daemon's pid and how to restart it.
- The TUI shows the same facts and asks before it restarts the daemon, even when the daemon hosts no
  session, because it cannot tell. On a yes, it stops the daemon and boots one from its own build,
  which restores the fleet itself.

## Listeners

The daemon serves several peers that speak different dialects, and each gets its own listener:

- **The client socket** carries the [client protocol](../protocol/protocol.md): long-lived
  connections that open with a handshake and carry requests, answers and events.
- **The reporter socket** takes one JSON line per connection from the session helpers: hook reports,
  statusline heartbeats, notes and message answers. A helper runs on every hook event, so a
  handshake per run would cost more than the report. A helper always exits 0 and drops its report
  when no daemon answers, so a broken daemon never breaks the session it reports on.
- **The events socket** streams every broadcast event to any local subscriber and reads nothing
  ([events](../protocol/events.md#the-events-socket)).
- **The TCP listener** serves the client protocol to a remote client such as atc-gateway, only when
  the daemon starts with one ([principals](../protocol/principals.md#the-tcp-listener)).

The daemon sets no mode on its unix sockets. They sit in `$XDG_RUNTIME_DIR`, which belongs to the
user alone, and a connection on the client socket acts as the owner with no credential. A session on
a remote host never reaches these sockets: it reaches the daemon through its
[session bridge](../execution/imp-provider.md#the-session-bridge).

## Clients and stopping

Clients are disposable. A client that crashes or loses its terminal costs nothing: the daemon drops
that connection's attachments and message tap, recomputes the terminal sizes of the sessions it was
attached to, and the fleet runs on. Each client keeps its own focused session, and a session streams
to every attached client.

A daemon that stops on purpose closes its connections and ends every local session, since a local
harness is the daemon's own child. It leaves every remote harness running and gives back the leases
it held on remote hosts, so the next daemon can attach to those harnesses again. It removes its
record, pid file and sockets, and keeps the lock file. A daemon that crashes leaves the same outcome
for its local sessions, because the pseudo-terminals close with it, and the next daemon restores
them from the stored fleet. Hook reports sent while no daemon runs are lost, so a restored session's
attention is current only from its next hook event.
