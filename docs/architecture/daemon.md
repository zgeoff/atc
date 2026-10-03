# Daemon architecture

A per-user daemon owns the sessions; thin clients attach over the [wire protocol](./protocol.md).
The first `atc` invocation boots the daemon if its socket is absent, then connects — tmux-style
auto-spawn. `atc daemon` runs it in the foreground for systemd or debugging.

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
beside it: its pid and the paths of its three sockets. A client that finds no daemon at its own
socket path reads that record and connects to the socket it holds before it boots a daemon.
Overlapping boots in one process share one spawn, and the TUI's `u` restart joins a restart that is
already running, with `⟳ restarting daemon` in the status bar until it finishes.

A client never stops a running daemon on its own, because stopping it ends every session it hosts. A
daemon from an older build stays in service, and the TUI marks it `⟳ update ready` until the user
presses `u`.

A daemon on another protocol version refuses the handshake, so a client cannot ask it to quit. A
non-interactive client, such as `atc mcp` or `atc mcp --http`, then exits with an error holding both
builds, both protocol versions, the daemon's pid, and how to restart it. The TUI shows the same
facts and asks before it restarts the daemon. On `y`, the TUI sends the daemon SIGTERM, boots one
from its own build, and restores the fleet; any other key exits and leaves the daemon running.
Without a handshake a client cannot learn whether the daemon hosts live sessions, so the TUI asks
even when it hosts none.

Clients are disposable. A client crash or terminal close costs nothing; the daemon detaches its
subscriptions and the fleet runs on. Each client has its own focused session, and a session streams
to every attached client. Per-client focus is a subscription (`session.attach`/`detach`) — an
unfocused session costs a client zero bytes.

## The three listeners

The daemon runs three socket listeners with different peers and different dialects, and they stay
separate:

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
Claude session there reports through an atc inside the imp: the one the target's `guestATC` names,
or a copy of the daemon's own binary at `bin/atc`, which a compiled daemon on Linux installs when
the imp lacks it. A daemon run from source has no binary to copy, so without `guestATC` it refuses a
remote Claude spawn with `unsupported_operation`. The session's settings and its copy of the
`atc-bridge` mod unpack into `sessions/<id>/`. Their statusline shows the session's own state alone,
never the rest of the fleet. A gateway session never runs remotely: its credential helper runs on
the daemon's machine.

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
call passes the execution check against the target identity the session binds to when its
materialization starts. The `workspace_materialization` table holds one row per materialization,
keyed by the session id, and the daemon records each phase in it before the phase starts:

| Phase          | What the daemon does                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `resolving`    | resolves the source to a URL and commit, checks the URL, and creates `cwd` with `mkdir`                                                |
| `cloning`      | clones the commit into a staging directory on its own host, sanitizes it, and tars it                                                  |
| `transferring` | unpacks the archive into `cwd` through `transfer`                                                                                      |
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
holds in `prefs`, and at which ownership epoch. A fleet write deletes and rewrites only the rows
this daemon owns, and a restore loads only those rows. A write that touches a session another daemon
owns, or one whose stored epoch is past this daemon's, fails whole with `stale_epoch`. Every row
this daemon writes holds epoch 1.

The `idempotency` table holds each idempotency key with its payload hash, its state, and the id of
the effect it covers; the [protocol](./protocol.md#idempotent-requests) covers the answers a retry
gets. A key completes only after the session's fleet row lands, so a completed spawn key always has
a fleet row behind it. The daemon reconciles keys left in progress before it opens its sockets, and
drops completed keys older than 24 hours at start and every hour after.
