# Daemon architecture

A per-user daemon owns the sessions; thin clients attach over the [wire protocol](./protocol.md).
The first `atc` invocation boots the daemon if its socket is absent, then connects — tmux-style
auto-spawn. `atc daemon` runs it in the foreground for systemd or debugging.

`atc mcp --http --wait-for-daemon` never boots a daemon: it waits for one to answer and exits when
none does, so a service manager's daemon unit keeps the state directory.
[Remote MCP](./remote-mcp.md#running-under-systemd) covers the units.

## One daemon per state directory

A daemon takes an exclusive lock on `daemon.lock` in its state directory before it opens `atc.db`,
binds a socket, or restores a session. The lock is a kernel `flock`, so two daemons started in the
same instant cannot both take it, and it dies with its process, so a crashed daemon never blocks the
next one. A daemon that finds the lock held waits two seconds for a daemon that is shutting down,
then exits with status 1 and a message holding the holder's pid and socket. The lock file is never
removed; removing it would let a newcomer lock a fresh file while the old daemon still holds the
removed one.

The lock follows the state directory, not the sockets. Socket paths come from `$XDG_RUNTIME_DIR`,
and a process whose environment lacks it, such as `atc mcp` under the Codex sandbox, computes socket
paths under the state directory instead. Once it holds the lock, the daemon writes `daemon.json`
beside it: its pid, the paths of its three sockets, and the port of its TCP listener when it has
one. A client that finds no daemon at its own socket path reads that record and connects to the
socket it holds before it boots a daemon. Overlapping boots in one process share one spawn, and the
TUI's `u` restart joins a restart that is already running, with `⟳ restarting daemon` in the status
bar until it finishes.

A client never stops a running daemon on its own, because stopping it ends every session it hosts. A
daemon from an older build stays in service, and the TUI marks it `⟳ update ready` until the user
presses `u`.

A daemon on another protocol version refuses the handshake, so a client cannot ask it to quit. A
non-interactive client, such as `atc mcp` or `atc mcp --http`, then exits with an error holding both
builds, both protocol versions, the daemon's pid, and how to restart it. The TUI shows the same
facts and asks before it restarts the daemon. On `y`, the TUI sends the daemon SIGTERM, boots one
from its own build, which restores the fleet itself; any other key exits and leaves the daemon
running. Without a handshake a client cannot learn whether the daemon hosts live sessions, so the
TUI asks even when it hosts none.

Clients are disposable. A client crash or terminal close costs nothing; the daemon detaches its
subscriptions and the fleet runs on. Each client has its own focused session, and a session streams
to every attached client. Per-client focus is a subscription (`session.attach`/`detach`) — an
unfocused session costs a client zero bytes.

## Restarting the daemon

`atc daemon restart` stops the running daemon, starts one in its place, restores the stored fleet on
it, and reports what came back. It exits 0 when every stored row came back on the expected build and
1 otherwise. `--dry-run` prints the preflight and stops, `--timeout <seconds>` caps the wait for the
restored fleet, and `--listen` and `--token-file` override the listener flags the replacement
inherits.

### The handoff

A restart can end the process that asked for it: `atc daemon restart` run inside a hosted session
dies with the daemon it stops. The command therefore hands the work to a worker, a detached process
in a session of its own that outlives the daemon. The worker writes a run log at
`restarts/<run id>.log` in the state directory, and the command prints `progress: <log path>`,
follows the log line by line, and exits with the code in the log's final result record. When the
worker ends without a result record, the command exits 1 and names the log. Each run removes logs
older than 7 days.

The worker starts through the same exec logic the daemon boot uses, and it drops `ATC_SESSION_ID`,
`ATC_SESSION_RECORD`, and `ATC_SOCKET` from every environment it passes on, so a replacement daemon
never mistakes itself for a hosted session. The command passes its own session id to the worker,
which marks that session in the report.

### The preflight

The worker prints the preflight before it stops anything. The preflight reads `daemon.json` and
probes the computed socket and the recorded one, then prints the daemon's pid, build, and protocol,
and the sessions in state `running`, which are mid-turn, by name and id. The session that ran the
command carries `(this session)`. When the daemon refuses the handshake on another protocol version,
the preflight prints the refusal and the daemon's build and version parsed from it, and says the
session states cannot be read. When no daemon answers and no live pid is recorded, the restart only
starts a daemon and restores the fleet.

Stopping the daemon ends every agent process it hosts. A session that is mid-turn loses that turn;
the restore resumes each session from its transcript, and the interrupted turn does not continue.

### The unit path

The restart goes through a systemd user unit only when two facts hold. The daemon's
`/proc/<pid>/cgroup` places it in a `<name>.service` below `user@<uid>.service`, and
`systemctl --user show -p MainPID --value <name>.service` returns exactly the daemon's pid. The
cgroup alone proves nothing: every process started from a session inside the unit, such as a daemon
a test starts, shares the unit's cgroup without being the process the unit runs.

On the unit path, the worker runs `systemctl --user restart <unit>`. `systemctl restart` stops the
unit's whole cgroup, which holds a hosted caller and its children, so the command starts the worker
through `systemd-run --user --collect --unit atc-daemon-restart-<run id>` as a transient unit of its
own. The transient unit takes `HOME`, `XDG_RUNTIME_DIR`, `PATH`, and every `ATC_` variable through
`--setenv`, because it would otherwise inherit the user manager's environment and with it the real
state directory. The unit decides the build, so the preflight prints the unit name and its
`ExecStart` path, and the listener overrides are ignored.

### The plain path

Every other daemon takes the plain path. The worker sends the daemon SIGTERM and waits 10 s for it
to exit, then sends SIGKILL and reports the kill. It then starts exactly one replacement, detached,
with the `--listen` and `--token-file` values from the old daemon's `/proc/<pid>/cmdline` unless the
restart flags override them, the environment from `/proc/<pid>/environ`, and the working directory
from `/proc/<pid>/cwd`. Reading the environment from the old daemon keeps the daemon's own `TERM`
instead of the caller's. Where `/proc` has no entry, as on macOS, the replacement takes the worker's
environment without the session variables, and the worker says so.

The worker waits up to 30 s for a daemon to answer whose pid differs from the old one and whose
record matches it. On the plain path that daemon must report this build. A different build means
another client won the start, and the restart fails.

### Restoring and verifying the fleet

On the new daemon the worker reads the stored rows with `fleet.list`, then calls `fleet.restore`,
which joins an automatic restore already in flight. It then polls `session.list` until every stored
row that is not exited is listed with a live terminal, or until the deadline passes. The deadline is
`--timeout` when set, else the number of live rows times `ATC_RESTORE_BOOT_TIMEOUT_MS` (15 s by
default) plus 30 s. An exited row counts as restored when it is listed. A stored row that is not
listed failed to restore, and a listed row without a live terminal at the deadline failed to revive.

### One restart at a time

The worker takes an exclusive `flock` on `daemon-restart.lock` in the state directory. A worker that
finds the lock held prints that it joins the restart in flight and waits up to 15 minutes for the
lock. It then reports the result the finished restart wrote to `restarts/last.json` and exits with
that result's code. A joined worker never stops or starts a daemon and never calls `fleet.restore`,
so two restarts requested at once restore the fleet once.

### The report

The report holds the final pid and build, the listen port when `daemon.json` records one,
`restored <n> of <m>`, each failed row by name, id, and reason, and the sessions the restart
interrupted. The worker writes the same data as a JSON result record to `restarts/last.json` and as
the final line of the run log.

## The listeners

The daemon runs three socket listeners with different peers and different dialects, and they stay
separate. A fourth, the [TCP listener](#the-tcp-listener), runs only when `atc daemon` is started
with `--listen`:

- The client protocol socket ([protocol](./protocol.md)): long-lived connections, handshake,
  request/response/event envelope.
- The reporter socket: a one-line NDJSON dialect spoken by `hook-report`, `statusline`, and
  `report`, short-lived processes spawned inside wrangled sessions on every hook event, statusline
  render, and message report. Forcing them through the framed protocol would mean a handshake per
  invocation. Hook and statusline reports feed the session state machine, which then emits
  `SessionState` / `PermissionRequested` protocol events to clients. Message reports update the
  [inbox](./protocol.md#messages), which emits `SessionMessage`.
- The [events socket](./protocol.md#events-socket): a read-only broadcast stream for outside
  subscribers, with no handshake and no requests.

## The TCP listener

`atc daemon --listen <host>:<port> --token-file <path>` serves the client protocol on a TCP port as
well as on the unix socket, for a remote client such as a gateway that routes MCP calls to several
daemons. The protocol carries no TLS, so the listener relies on the tailnet's WireGuard encryption:
`--listen` takes only a loopback address (`127.0.0.0/8`, `::1`) or one in the tailnet ranges
`100.64.0.0/10` and `fd7a:115c:a1e4::/48`, written as an IP literal. `0.0.0.0`, `::`, other
addresses, and host names refuse the start, and so does `--listen` without `--token-file`. Write an
IPv6 host in brackets (`[fd7a:115c:a1e4::7]:8415`). Port `0` lets the kernel pick a free port, and
`daemon.json` holds the port the listener bound once the daemon answers a handshake. The listener
binds before the unix socket, so a bind that fails, such as on a port another socket holds, refuses
the start with the address and the error code before any client connects, and releases the lock.

The listener applies no source-address allow-list: the bearer token is the gate. The token file
holds one or two tokens, one per line, each at least 32 bytes once whitespace around it is trimmed.
A file that cannot be read, is empty, holds a blank line or a third line, or holds a short token
refuses the start. Under systemd, `LoadCredential=` supplies the file, and `--token-file` points at
`$CREDENTIALS_DIRECTORY/<credential name>`. The [TCP handshake](./protocol.md#tcp-handshake) covers
how a connection presents the token and what it may do once in.

`SIGHUP` reloads the token file. The daemon closes at once every TCP connection whose handshake
token the file no longer holds, so a removed token stops working for open connections as well as for
new handshakes. A reload of an invalid file fails closed: the daemon drops every token, closes every
TCP connection, refuses every handshake with `unauthorized`, and logs the reason to stderr until a
reload succeeds. Rotate a token without downtime in four steps:

1. Add the new token as a second line and send `SIGHUP`.
2. Give the client the new token and restart it.
3. Remove the old token from the file.
4. Send `SIGHUP` again.

The listener logs to stderr, one `key=value` line per event, for a journal alert to match:

```text
atc tcp event=listening host=127.0.0.1 port=8415
atc tcp event=handshake_refused peer=100.64.0.7 reason=unauthorized count=1
atc tcp event=principal_refused peer=100.64.0.7 principal=unlisted count=1
atc tcp event=refused peer=overflow count=1
atc log dropped=212
```

The `reason` is one of `missing_token`, `unauthorized`, `delay_cap_full`, `closed_during_delay`,
`unexpected_line`, and `line_too_long`. A principal refusal covers a handshake and a request alike,
and its line never holds the principal the peer sent, which could hold a token. No line holds a
token or any part of one. The peer address is cut to 64 characters, and every control character,
space, `=`, `"`, `\`, and non-ASCII character in it is written as a `\u{hex}` escape.

The first refusal of one kind from one peer logs at once with `count=1`. Later ones within a minute
are counted, and a line with their count follows at the first refusal from any peer after the minute
ends, or when the daemon stops, so the counts of every line sum to every refusal. The daemon tracks
at most 1024 such windows. While all 1024 are open, a refusal that would open another counts toward
one window with `peer=overflow` instead, so a flood from many addresses logs at most about 1024
lines a minute.

The listener's writes to stderr never block the daemon. Up to 64 KiB of lines wait while stderr
takes no more; past that a line is dropped, and once stderr takes lines again, an
`atc log dropped=N` line holds how many were lost. A stopping daemon waits up to one second for
stderr to take the lines still waiting, then exits, so stderr that nobody reads delays the exit by
no more than that second and loses the lines it never took.

`atc daemon id` prints the running daemon's `daemonID` over the owner's unix socket, for a client
that pins the daemon's identity. It exits with status 1 when no daemon answers.

## User hooks

Every broadcast event also fires the user's configured hooks: the daemon runs each matching command
with the event's JSON on stdin, exactly the line clients receive — the
[events guide](../guides/events.md#daemon-hooks) covers configuration and semantics. Hooks are
observational and fire-and-forget, so a broken hook can neither gate an event nor slow an attach.
`SessionOutput` never reaches hooks — it is attach-scoped screen bytes, not fleet state.

## Screen model

A headless terminal emulator per session (`@xterm/headless` + serialize addon) consumes every PTY
byte continuously — background output is consumed, not discarded. Attach-replay, backpressure
collapse-to-repaint, and multi-client fidelity all depend on it, and it is also a detector input:
"is this agent waiting at a prompt?" is answerable from screen state for agents with no hook system.
Scrollback is capped aggressively (current screen plus a few hundred lines).

## Sessions and adapters

- A session is the universal core — state machine (`running` / `needs_you` / `done` / `exited`),
  attention flag, identity — plus a `kind`: `pty` (terminal bytes) or `headless` (structured
  messages from an Agent SDK run, no terminal at all). The kind is carried in every descriptor and
  attach.
- Everything agent-specific lives in an adapter implementing `AgentAdapter`: spawn arguments,
  instrumentation, resume semantics, and name-pulling for Claude, Grok, Codex, and each configured
  gateway. The core never knows about a particular CLI, and lookup never returns a different kind
  than the one asked for.
- Attention detection is a per-adapter detector stack: hooks where they exist, screen heuristics as
  the universal fallback.

## Execution providers

An execution provider is the host a session's harness runs on. The daemon starts every session
terminal through the provider's interface, in `src/daemon/execution-provider.ts`, and never reaches
past it. The built-in `local-pty` provider runs each harness as a child process of the daemon on a
`bun-pty` pseudo-terminal.

A provider declares its capabilities, and the daemon checks the declaration before it calls the
provider:

| Capability | What the host can do                                     |
| ---------- | -------------------------------------------------------- |
| `spawn`    | start a harness in a pseudo-terminal                     |
| `attach`   | stream a running harness's output to attached clients    |
| `input`    | write keystrokes to a running harness                    |
| `resize`   | change a running harness's terminal size                 |
| `kill`     | end a running harness                                    |
| `transfer` | unpack a tar archive into a directory on the host        |
| `run`      | run a command on the host to completion                  |
| `headless` | run an agent turn without a terminal                     |
| `suspend`  | pause the host and resume it later with its state intact |
| `destroy`  | delete the host and everything on it                     |

Each configured execution target has its own provider, and every session holds the target it runs
on. Every path that starts work on a session asks one check, `findExecutionRefusal`, for the
session's target and the capability it needs, so no path can run a session on another target or fall
back to the daemon's own machine. The [protocol](./protocol.md#targets) covers the refusals. A
request that needs a capability the provider lacks fails with `unsupported_operation`. A host
without `resize` keeps its terminal at the size it started with, while the session's screen model
follows the attached clients. `local-pty` declares every capability except `suspend` and `destroy`:
its host is the daemon's own machine.

A provider is local or remote. A local harness inherits the daemon's environment around the
variables atc sets for it. A remote harness gets only those variables and the host's own terminal,
locale, and `PATH`, so nothing from the daemon's environment reaches the remote host. Before a
harness starts, the daemon asks the provider to prepare its host, which creates, wakes, or holds a
remote host and refuses with `host_unavailable` when it cannot. The daemon awaits that step, then
starts the harness and follows its output from the first byte.

### The imp provider

The `imp` provider runs each top-level session in an imp of its own, a VM that impd hosts, and each
sub-session on the same target in its parent's imp. It declares every capability except `headless`.
The daemon reaches impd only through an imp port, the interface in `src/daemon/imp-port.ts`, and the
tests drive a fixture port that runs real pseudo-terminals.

A sub-session joins its parent's imp only when its resolved target matches the parent's binding, in
both name and identity. A nested spawn without a target resolves to `defaultTarget` like any other
spawn, so it joins only when that default is the parent's target. Any other sub-session gets a host
of its own. Inside the parent's imp, the sub-session is one more imp session:

- Its spawn takes the daemon's lease, which wakes the imp when the parent left it asleep.
- A kill of the sub-session ends its own harness alone and never sleeps the imp.
- Sleep and destroy follow the parent: a kill of the parent sleeps every session in the imp, and a
  confirmed forget of the parent destroys them all.

The daemon holds an imp with a lease labelled `atc-<daemonID>`, renews it at a third of its length
while a harness runs there, and gives it back when the imp's last harness ends. A kill gives the
lease back first, then asks impd to sleep the imp without force. When another owner's lease refuses
the sleep, the daemon takes its own lease back and the kill fails with `host_leased`. A confirmed
`session.forget` destroys the imp, which ends every lease on it. A start that fails while it readies
the imp takes back only what it did: it destroys an imp it created, since no session holds it, and
on an imp that existed before, it gives back the lease it took and leaves the imp. A fleet restore
logs a session whose revive fails, the first one included, and goes on to the next.

Each harness is an imp session named after its atc session, and the daemon is its one attacher. A
kill of a sub-session sends its process `SIGHUP`. When the daemon stops, it closes its connections,
leaves every imp session running, and gives its leases back, so an idle imp sleeps after impd's idle
timeout. The next daemon's revive wakes the imp from memory and attaches to the session again.

Each session's files live under the target's `guestDir` inside the imp, `/tmp/atc` by default. A
Claude session there reports through the atc at `bin/atc` in that folder, which the daemon readies
before the session starts:

- With `guestATC` set, the first readying of each imp runs one command that prints the version of
  the image's atc at that path. When it matches the daemon's own version, `bin/atc` becomes a link
  to the image's atc and nothing uploads.
- When the image's atc prints another version or is missing, a compiled daemon on Linux copies its
  own binary to `bin/atc`. It keeps a `bin/atc` that prints its own version and copies nothing.
- Without `guestATC`, a compiled daemon on Linux copies its own binary to `bin/atc` when the imp
  lacks one.

The daemon reads the image's version once per imp. A later readying restores the link or the copy,
which a cold boot of the imp removes, and reads no version. Each readying logs which atc the hooks
run and both versions. A daemon run from source has no binary to copy, so it refuses a remote Claude
spawn with `unsupported_operation` when the target sets no `guestATC`, or when the image's atc is
missing or prints another version. Its refusal holds both versions.

The session's settings and its copy of the `atc-bridge` mod unpack into `sessions/<id>/`, and the
session's [record](./session-record.md) lands read-only at `records/<id>.json`. Their statusline
shows the session's own state alone, never the rest of the fleet. A gateway with a credential helper
and no `auth` never runs remotely, since the helper runs on the daemon's machine. A gateway with
`auth`, and stock Claude with `auth`, run on an imp with a Claude config folder of their own under
`sessions/<id>/` and a placeholder in place of the credential, which impd's broker swaps for the
secret; the [brokered credentials](../guides/configuration.md#brokered-credentials) guide covers the
config. A stock Claude session with `auth` also takes the
[Claude config bundle](../guides/configuration.md#claude-config-bundle) into its config folder at
each launch, staged beside it in `claude-config-bundle/`.

Each harness gets a socket inside the imp under `run/`, named for its session, which `ATC_SOCKET`
points at, with `ATC_BRIDGE=1` beside it. impd forwards each connection there to the daemon, which
serves it as the [session bridge](./protocol.md#session-bridge); the daemon never exposes its own
sockets to the imp. Through the bridge, the session's hooks report, `atc report` sends notes and
answers, `atc tap` takes the session's messages, and the statusline reads the session's state. An
agent with a sign-in check runs it inside the imp before its harness starts, and a failed check
refuses the spawn with `auth_not_configured`.

Each harness start or attach binds its bridge to the session, the target and target identity, the
host, and a new epoch. Every line on the bridge checks that binding against the live session first,
and fails closed with `stale_binding` once the session is gone, has moved, or has started or
attached again. The binding holds no secret: reaching the socket inside the imp is the proof. One
imp is one trust domain, so a sub-session in its parent's imp can reach the parent's socket too. The
per-session socket and binding stop accidental crossings between sessions, never a hostile process
inside the same imp.

The guest tap reconnects after every dropped connection, as a sleep or a daemon restart leaves it,
with a wait that grows to 5 seconds and never ends. Each new connection replays the messages not yet
acked; the tap prints each message once and acks a repeat again. `atc report` keeps each report in
an outbox beside the socket until the bridge takes it or refuses it as `forbidden`, and the tap
sends the outbox again on every connection. The tap removes only the outbox file behind a report it
sent on that connection, whatever id an answer holds. A resent note lands once, under the id the
reporter gave it, and a resent answer changes nothing. A harness restart leaves delivered messages
delivered, as a local session does.

A connection that ends without an exit reconnects without waking the imp, and the session lists as
`reattaching` until it does. Where impd carries offsets, the daemon resumes after the last byte it
has, at the generation it last saw, and drops any byte below that offset, since impd may repeat
bytes across connections. A resume that finds a gap, an offset impd refuses, or an imp without
offsets gets a fresh attach instead: the daemon clears the screen, then takes impd's replay. impd's
answer to the reconnect decides how the harness ended:

- A sleeping imp leaves the session asleep, for a revive to find.
- A process impd no longer holds in the same boot ended with the exit code impd kept for its
  generation.
- A process lost to a cold boot ended with the cause of the first boot after the daemon's own, such
  as `imp rebooted (watchdog)`. Without the daemon's boot among impd's last four cold boots, it
  ended with the cause unknown.

## Workspace materialization

The daemon builds a spawn's [workspace](./protocol.md#workspaces) on the session's target through
two provider operations, `transfer` and `run`, and nothing specific to one provider. Each provider
call passes the execution check against the target identity the session binds to when its spawn
starts, and runs on the session's host. Materialization starts only after every refusal of the spawn
has passed, its runtime auth checks included. The daemon resolves the source first, then readies the
host the workspace lands on: the session's own host, or its parent's when the two share one. A
materialization that fails once the host is ready takes back a host of the session's own, with the
imp and binding its spawn provisioned, and leaves a parent's host running. A spawn whose harness
fails to start once its workspace is ready, before or after its session lists, takes back the same:
it destroys a host of its own, and on a host that stays, a parent's or the daemon's own machine, it
removes only the directory its materialization created, by the rules below. A retry into the same
`cwd` then starts clean.

The workspace has one directory: the physical path `cwd` resolves to, with every symlink in it
resolved, on the session's host once it is ready, or on the daemon's own machine for a target
without hosts. The daemon creates, fills, verifies, and removes that path, and never removes
anything through `cwd` as written.

On a shared host, a workspace spawn claims its `cwd` against every session listed there and every
other workspace spawn in flight there, in the same step that checks it, so two concurrent spawns
never both take nested directories. Once the host is ready, the daemon checks the claim again with
each directory as the host resolves it, symlinks and relative directories included, and records the
physical path on the claim. It reads the listed sessions again after each wait, and decides with the
sessions listed then. A refused spawn's `workspace_overlap` holds the session or spawn whose
directory it overlaps as `data.session`. The claim holds until the session lists or the spawn fails.
A spawn that fails as `outcome_unknown` keeps its claim with no expiry, since its directory may
still hold what it left, and a daemon restart releases it. A plain sub-session spawn on a shared
host holds its `cwd` the same way until it lists, and is refused with `workspace_overlap` when that
`cwd` lies inside or around a workspace another spawn is still building there. Plain spawns share
directories with each other and with listed sessions freely. While a failed workspace spawn removes
its directory on a host, every plain spawn there is refused with `workspace_overlap`. A rollback
resolves the directory of each plain spawn still starting there, relative ones included, and keeps
its own directory when one of them lies inside or cannot be resolved.

A failure removes the directory it created only while no listed session's or other claim's directory
lies inside it, and only while the path still resolves to itself on the host: the removal enters the
directory, checks where it landed, and removes the contents from inside. Otherwise the directory
stays, the daemon logs it, and the refusal holds it as `data.leftDir`; a refusal that answers
`outcome_unknown` carries no data, so there the log is the only record. The
`workspace_materialization` table holds one row per materialization, keyed by the session id, and
the daemon records each phase in it before the phase starts:

| Phase          | What the daemon does                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving`    | resolves the source to a URL and commit, checks the URL, readies the host, and creates `cwd` with `mkdir`                              |
| `cloning`      | clones the commit into a staging directory on its own host, sanitizes it, and tars it                                                  |
| `transferring` | unpacks the archive into `cwd` through `transfer`; an imp target sends it gzipped and refuses the phase when the imp has no gzip       |
| `verifying`    | runs `git rev-parse` and `git status` in `cwd` through `run`, and checks HEAD is the pinned commit with every tracked file matching it |
| `ready`        | starts the session in `cwd`                                                                                                            |
| `failed`       | holds the refusal code, after removing a `cwd` the materialization created                                                             |

The session registers only once its workspace is ready, so no client lists a session over a partial
checkout. The row holds the URL without its credential, the commit, and the ref, and never a
credential. It also holds the names of the variables the session withholds: the `credentialRef`
variable, `GIT_ASKPASS`, and `ATC_GIT_ASKPASS_SECRET`. The harness starts without them on every
provider, and so does each revive and headless run of the session. A fleet load returns a ready
row's provenance and withheld names with its session.

A daemon that stops partway through leaves a row short of ready. The next daemon fails every such
row as `workspace_interrupted` before it serves a request. The interrupted spawn never registered a
session, and a retry under its idempotency key gets `outcome_unknown`, like a retry of any
interrupted spawn. A `cwd` the interrupted materialization created stays on the target, and a spawn
into it is refused as `workspace_exists`.

## State

SQLite (`bun:sqlite`) in the daemon holds the fleet, event trail, spawn history, and last-used agent
in one store with no cross-process write races; the [overview](./overview.md#state) covers the
files. `status.json` alone stays a plain file, because statusline reporters in wrangled sessions
read it without speaking the protocol.

The fleet table keys each row by the atc session id. The agent session id is optional, since a row
exists from the moment a session spawns, and unique, since one agent session belongs to one row.
When a resume gives a second session the same agent session id, the row written last replaces the
earlier one. The write then relinks the rows it keeps as a one-level hierarchy. A link to a replaced
row moves to the row that replaced it, and a row that was a sub-session of the row it replaced takes
that row's parent instead. A row linked to a row the fleet does not hold becomes top-level. Where
two crossed resumes leave rows linked in a cycle, the row written first in the cycle becomes
top-level. A row whose parent is itself a sub-session moves up to the top-level row above it. No row
is its own parent, and every parent is a top-level row the fleet holds.

The `session_owner` table records which daemon owns each fleet row, by the `daemonID` the store
holds in `prefs`, and at which ownership epoch. A restore loads only the rows this daemon owns.

A fleet write rewrites this daemon's rows for the sessions it lists and deletes its rows for the
sessions it dropped on purpose since the last write. The write also deletes this daemon's row for
any agent session id a listed session holds, so the fleet keeps one row per agent session id. Every
other row stays as it is: after a restart, a spawn or rename before the fleet restore leaves the
stored fleet restorable. A write that touches a session another daemon owns, or one whose stored
epoch is past this daemon's, fails whole with `stale_epoch`. Every row this daemon writes holds
epoch 1.

The `idempotency` table holds each idempotency key with its payload hash, its state, and the id of
the effect it covers; the [protocol](./protocol.md#idempotent-requests) covers the answers a retry
gets. A key completes only after the session's fleet row lands, so a completed spawn key always has
a fleet row behind it. The daemon reconciles keys left in progress before it opens its sockets, and
drops completed keys older than 24 hours at start and every hour after.
