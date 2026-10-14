# The imp provider

The `imp` provider runs each top-level session in an imp of its own, a VM that impd hosts, and each
sub-session on the same target in its parent's imp. An imp can sleep with its processes inside and
wake later from memory, so a kill puts the imp to sleep rather than ending the session, and a revive
finds the agent exactly as it was. The provider declares every capability except headless runs. The
daemon reaches impd only through an imp port, an interface the tests drive with a fixture port that
runs real pseudo-terminals.

[Targets](./targets.md) covers the checks every provider shares, and
[runtime auth](./runtime-auth.md) covers the broker grants an imp can hold.

## Holding an imp

A sub-session joins its parent's imp only when its resolved target matches the parent's binding in
both name and identity; any other sub-session gets an imp of its own. Inside the parent's imp, a
sub-session is one more process: its spawn wakes the imp when the parent left it asleep, and a kill
of the sub-session ends its own harness alone and never sleeps the imp.

The daemon holds an imp with a lease labelled with its daemon id. It renews the lease while a
harness runs there and gives it back when the imp's last harness ends, so impd sleeps an idle imp on
its own. A kill gives the lease back first, then asks impd to sleep the imp without force. When
another owner's lease keeps the imp awake, the daemon takes its own lease back and the kill fails
with `host_leased`, so a kill never pulls an imp out from under someone else. A confirmed forget
destroys the imp, which ends every lease on it.

A start that fails while it readies the imp takes back only what it did. It destroys an imp it
created, since no session holds it, and on an imp that existed before, it gives back the lease it
took and leaves the imp.

Each harness is an impd session named after its atc session, and the daemon is its one attacher.
When the daemon stops, it closes its connections and gives its leases back but leaves every harness
running, so an idle imp goes to sleep with its sessions inside. The next daemon's revive wakes the
imp from memory and attaches to each harness again. A daemon that crashes cannot give its leases
back, so each one lapses when its length runs out, and the next daemon takes its leases under the
same label, since the label holds the daemon id the store keeps.

## The guest folder

Each session's files live in the target's guest folder inside the imp. A Claude Code session there
reports through an atc inside the imp, which the daemon readies before the session starts:

- When the target points at the image's own atc and that atc prints the daemon's version, the daemon
  links to it and uploads nothing. It reads the image's version once per imp.
- Otherwise a compiled daemon on Linux copies its own binary into the guest folder.
- A daemon run from source has no binary to copy, so it refuses a remote Claude Code spawn whose
  image holds no matching atc, and its refusal holds both versions.

A cold boot of the imp clears the guest folder, so each readying restores the link or the copy. The
session's settings and its copy of the `atc-bridge` mod unpack into a folder for the session. Its
[record](./session-record.md) goes to impd's read-only files, which no process in the imp can write.
A remote session's statusline shows its own state alone, never the rest of the fleet, because the
imp holds no copy of the fleet.

## The session bridge

A session inside an imp never reaches the daemon's sockets. Each harness gets a socket of its own
inside the imp, which impd forwards to the daemon, and the daemon serves it as the session bridge, a
closed dialect of its own. Through the bridge, the session's hooks report, its notes and answers
land, its tap takes messages, and its statusline reads the session's state:

| Operation     | Does                                                            |
| ------------- | --------------------------------------------------------------- |
| a hook line   | a hook report for this session, as the reporter socket takes it |
| `note`        | a note or an answer, landing once under the id it carries       |
| `tap.open`    | makes this connection the session's message tap                 |
| `tap.ack`     | marks a message delivered                                       |
| `status.read` | the session's own state                                         |

Every operation acts on the session the bridge serves, so no line holds a session id, and no
operation changes the session's record. The bridge answers an unknown operation, a malformed line or
a hook line for another session with `forbidden`, and closes the connection.

Each harness start or attach binds its bridge to the session, its target and identity, its host and
a new epoch. Every line checks that binding against the live session first and fails closed with
`stale_binding` once the session is gone, has moved, or has started or attached again, so an old
harness can never report as a new one. The binding holds no secret: reaching the socket inside the
imp is the proof. One imp is one trust domain, so a sub-session in its parent's imp can reach the
parent's socket too. The per-session socket and binding stop accidental crossings between sessions,
never a hostile process inside the same imp.

Every hook report and note opens a connection of its own, so the bridge closes each connection once
the guest has written its last line and the bridge has answered the lines before it. impd keeps a
relayed connection open until both ends have finished, and caps how many one forward holds open. A
bridge that waited for the guest alone would fill that cap within one long turn, and impd would then
close each new connection unread: hooks would be lost, and notes would wait in the outbox.

## Reconnecting

A connection to a harness that ends without an exit reconnects without waking the imp, and the
session lists as `reattaching` until it does. Where impd carries output offsets, the daemon resumes
after the last byte it holds, at the generation it last saw, and drops any byte below that offset,
since impd may repeat bytes across connections. A resume that finds a gap, an offset impd refuses,
or an impd without offsets gets a fresh attach instead: the daemon clears the screen and takes
impd's replay.

impd's answer to the reconnect decides how the harness ended:

- A sleeping imp leaves the session asleep, for a revive to find.
- A process impd no longer holds in the same boot ended with the exit code impd kept for its
  generation.
- A process lost to a cold boot ended with the cause of the first boot after the daemon's own, such
  as a watchdog reboot, or with the cause unknown when impd no longer remembers the daemon's boot.

The session bridge's socket comes back on a reconnect of its own. impd ends the reverse forward
behind it for good when the forward's tunnel socket closes, while the harness runs on. The provider
therefore listens on the same socket again until the harness ends. A hook that runs in the gap finds
no socket and is lost, while a note waits in the outbox beside the socket for the next connection. A
forward that the imp's sleep ended stays ended, because a listen wakes a sleeping imp; the harness
that a wake revives opens a forward of its own.
