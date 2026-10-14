# Restarting the daemon

`atc daemon restart` replaces the running daemon with one from the current build, restores the
stored fleet on it, and reports which sessions came back. A restart ends every local agent process,
so a session that is mid-turn loses that turn, and the restore resumes each session from its
transcript without continuing the interrupted turn. The TUI's `u` key and its protocol-mismatch
prompt restart the daemon in-process instead, and
[the daemon](./daemon.md#builds-and-protocol-versions) covers when they do. The
[daemon restart guide](../../guides/using-atc.md#restarting-the-daemon) covers the command's flags
and exit codes.

## The handoff to a worker

A restart can end the process that asked for it, because `atc daemon restart` run inside a hosted
session dies with the daemon it stops. The command therefore hands the work to a worker, a detached
process in a session of its own that outlives the daemon. The worker writes a run log in the state
directory, and the command follows the log line by line and exits with the code in its final result
record. A worker that ends without a result record makes the command fail and name the log.

The worker strips the session variables from every environment it passes on, so a replacement daemon
never mistakes itself for a hosted session. The command passes its own session id to the worker,
which marks that session in the report.

Before it stops anything, the worker prints a preflight: the daemon's pid, build and protocol, and
the sessions that are mid-turn. When the daemon refuses the handshake on another protocol version,
the preflight says the session states cannot be read. When no daemon answers and no live pid is
recorded, the restart only starts a daemon and restores the fleet.

## Two paths

The worker restarts through a systemd user unit only when two facts hold: the daemon's cgroup is a
service under the user's manager, and that service's main pid is exactly the daemon's pid. The
cgroup alone proves nothing, since a process can sit in the unit's cgroup without being the process
the unit runs.

- **The unit path.** The worker restarts the unit. The stopping daemon stops the scope of every
  local session, which holds the hosted caller and its children, so the command starts the worker as
  a transient unit of its own. That transient unit takes the caller's home, runtime directory, path
  and atc variables explicitly, because it would otherwise inherit the user manager's environment
  and with it the real state directory. The unit decides the build.
- **The plain path.** The worker sends the daemon SIGTERM, then SIGKILL when it does not exit in
  time, and reports the kill. It starts exactly one replacement with the old daemon's listener
  flags, environment and working directory, read from `/proc`, so the daemon keeps its own terminal
  type rather than the caller's. Where `/proc` has no entry, as on macOS, the replacement takes the
  worker's environment without the session variables, and the worker says so. The replacement must
  report this build. Another build means another client won the start, and the restart fails.

## Verifying the fleet

The worker reads the stored rows from the new daemon, asks it to restore the fleet, and joins the
automatic restore when one is already in flight. It then polls until every stored row that is not
exited is listed with a live terminal, or a deadline that grows with the number of live rows passes.
The deadline allows each live row the per-session boot cap that the
[restore](./fleet-and-restore.md) waits out, and it reads that cap from
`ATC_RESTORE_BOOT_TIMEOUT_MS`, as the daemon does. A stored row that is not listed failed to
restore, and a listed row without a live terminal at the deadline failed to revive. A row whose
agent the new daemon's config no longer holds fails at once, since no wait gives it a terminal, so
the restart ends without waiting out the deadline once every other row is back. A row whose restore
was refused for good fails at once for the same reason, with the refusal's code and message as its
reason. The daemon marks such a row in its session view only while the row still lists that refusal
and the restore has no further try for it.

The report holds the final pid and build, `restored <n> of <m>`, each failed row with its reason,
and the sessions the restart interrupted. The worker writes the same data as a result record, which
is the final line of the run log and the content of `restarts/last.json`.

## One restart at a time

The worker takes an exclusive `flock` on a restart lock in the state directory. A second worker that
finds the lock held joins the restart in flight: it waits for the lock, then reports the result the
finished restart wrote and exits with that result's code. A joined worker never stops or starts a
daemon and never asks for a restore, so two restarts requested at once restore the fleet once. A
joined worker fails instead of reporting when its wait for the lock runs out, or when the finished
restart left no result.
