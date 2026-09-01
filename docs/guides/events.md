# Events

Everything the fleet does broadcasts as a wire event — sessions added, state changes, attaches,
renames, permission requests. Each event is one JSON line, identical for every consumer; the
[protocol](../architecture/protocol.md#events) defines the event names and shapes. Three consumers
ride the stream: daemon hooks for running your own commands, `atc events` for a stdout feed, and the
events socket for a direct subscription.

## Daemon hooks

The daemon runs your commands when fleet events happen — focus another window when a session needs
you, tell another tool which session just got attached. Configure them in the `hooks` map of
[`config.json`](./configuration.md), keyed by event name:

```json
{
  "hooks": {
    "SessionAttached": [{ "command": "jq -r .session.cwd | xargs my-focus-script" }],
    "SessionState": [{ "command": "notify-atc", "dir": "~/projects/ork", "timeout": 3000 }]
  }
}
```

Each command runs through `/bin/sh -c` with the event's JSON on stdin and the event name in
`$ATC_EVENT`.

| Field     | Default  | Meaning                                                                                             |
| --------- | -------- | --------------------------------------------------------------------------------------------------- |
| `command` | required | The shell command to run. An entry without one is left out.                                         |
| `dir`     | none     | Only fire for sessions whose repo root or working directory sits at or under this path (`~` works). |
| `timeout` | `10000`  | Milliseconds before a still-running hook is killed.                                                 |

Hooks are observational and fire-and-forget: the daemon never waits on one, and a nonzero exit is
logged and ignored — a broken hook cannot break the daemon or gate an event. The `dir` match uses
the session as it was at the emit site, so a dir-scoped hook still fires for the removal of a
matching session. Events that carry no session, such as `PermissionResolved`, skip `dir`-filtered
entries.

## `atc events`

`atc events` prints the stream to stdout, one NDJSON line per event: first the current fleet as
`SessionAdded` lines, then every event behind it, until the daemon goes away. Pipe it into `jq` or
your own daemon:

```sh
atc events | jq -r 'select(.ev == "SessionState") | .session.name + " -> " + .session.state'
```

When no atc daemon is running, `atc events` exits nonzero with a hint instead of booting one.

## The events socket

`atc events` is a thin reader over `$XDG_RUNTIME_DIR/atc-events.sock`, and any program can connect
to that socket directly — no handshake, no version negotiation, no requests. The daemon ignores
anything written to it. On connect you receive the same fleet snapshot as `SessionAdded` lines, then
live events.

A subscriber written against one atc version keeps working across upgrades: every line carries the
protocol version, and unknown fields are ignored by contract. The
[protocol](../architecture/protocol.md#events-socket) covers the delivery contract — bounded
per-subscriber queues, disconnect on overflow with a fresh snapshot on reconnect, and no
`SessionOutput` (screen bytes stay attach-scoped).
