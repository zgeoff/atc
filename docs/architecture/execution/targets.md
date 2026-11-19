# Execution targets

A session's harness, the agent CLI process that atc hosts, runs on an execution target: the daemon's
own machine, or a remote host such as an imp, a VM that impd runs. Each target in the config names a
provider, and the daemon starts, feeds and ends every harness only through that provider's
interface. A session binds to its target when it spawns and runs nowhere else for its whole life, so
the daemon refuses a request that cannot run on the session's target, and never runs it on its own
machine in place of the target.

[The imp provider](./imp-provider.md), [the docker provider](./docker-provider.md) and
[the sprites provider](./sprites-provider.md) cover the remote providers,
[workspaces](./workspaces.md) covers building a session's working directory on its target, and the
[configuration guide](../../guides/configuration/targets.md) covers setting targets.

## Providers and capabilities

The built-in `local-pty` provider runs each harness as a child process of the daemon on a
pseudo-terminal. The `imp` provider runs it in a VM, the `docker` provider in a container on the
daemon's own machine, and the `sprites` provider in a sprite on Fly.io; the docker and sprites
providers need the daemon to be a compiled binary. A provider declares what its host can do, and the
daemon checks the declaration before it calls the provider:

| Capability | What the host can do                                     |
| ---------- | -------------------------------------------------------- |
| `spawn`    | start a harness in a pseudo-terminal                     |
| `attach`   | stream a running harness's output                        |
| `input`    | write keystrokes to a running harness                    |
| `resize`   | change a running harness's terminal size                 |
| `kill`     | end a running harness                                    |
| `transfer` | unpack an archive into a directory on the host           |
| `run`      | run a command on the host to completion                  |
| `headless` | run an agent turn without a terminal                     |
| `suspend`  | pause the host and resume it later with its state intact |
| `destroy`  | delete the host and everything on it                     |
| `relay`    | carry the session bridge's lines over the host's streams |

`local-pty` declares every capability except `suspend` and `destroy`, since its host is the daemon's
own machine. What a session's kill and forget do follows from these two: a target that can suspend
puts its host to sleep on a kill, and a revive later wakes it with the harness inside. A target that
can destroy its host makes a forget take a confirm token
([sessions](../daemon/sessions.md#ending-a-session)).

A remote provider that declares no `relay` cannot carry a session's hooks to the daemon, so the
daemon refuses a spawn on it with `unsupported_operation` and the problem `no_session_bridge`,
before it touches the host.

A provider operation that fails after its effect began, and cannot confirm that it took the effect
back, throws an `EffectRemainsError` whose cause is the provider's refusal. The daemon's
[idempotency ledger](../protocol/idempotency.md) then keeps the request's key as an unknown outcome
and never runs the effect again under it. Any other failure means the effect did not happen, so the
daemon releases the key for a retry.

### The relay

The session bridge is the socket inside the host that the agent's hook and note reporters write
their lines to. On imp, impd forwards the bridge to the daemon. Every other remote provider carries
it over a byte stream of its own, such as a container's attach or an exec's stdin and stdout,
through one relay:

- On the daemon's side, `openStreamRelay` in `@atc/plugin-api` numbers and acks the frames both
  ways, and replays the unacked ones after a dropped connection. The provider supplies only the
  stream.
- On the host's side, `atc relay-mux <socket>` binds the bridge socket before it reads stdin, so a
  reporter never finds the socket missing, and keeps its bridges when stdin closes.

Each connection opens with a hello from the daemon, and the mux answers with a welcome. These rules
hold:

- The daemon writes a newline before each hello, to end any half line that a cut-off write left in
  the mux's stdin.
- A connection that gets no welcome within `WELCOME_TIMEOUT_MS` of its hello counts as dropped. The
  daemon then retries for as long as the link lasts: it waits each delay of the provider's
  `reconnectDelaysMs` in turn, and repeats the last delay after that.
- When a welcome carries a version `v` that the daemon cannot speak, the daemon opens the link again
  with `replace: true`. The provider's link then stops the old mux and starts a new one, which
  answers with `reset: true`.
- Each `openStreamRelay` call takes a new relay id, so a daemon restart or a revive resets the mux.
  The mux then closes its bridges and drops their unacked frames, and both sides number from 1
  again. A hook line in flight is lost. A note is not, because the note reporter keeps it in its
  outbox and sends it again.
- When the link ends `lost`, because the host no longer runs the mux, the daemon closes every bridge
  connection and stops its retries. The harness's exit then reaches the daemon the usual way.
- Each side holds at most `MAX_UNACKED_BYTES` of unacked frames. On the daemon's side, `writeLine`
  settles only once its frame fits. On the mux's side, a new reporter connection waits, and the
  sockets pause, until acks free room.
- The frames live in the `@atc/protocol/relay` entry, which imports neither Zod nor the contract, so
  the mux starts fast.

### Local harnesses under a systemd service

When a systemd user service runs the daemon, the `local-pty` provider starts each harness in a
transient scope of its own, so the service's cgroup holds only the daemon. When a harness leaves
behind a process that cannot exit, such as one stuck in an uninterruptible wait on a hung
filesystem, only that harness's scope hangs in its stop, and a stop or restart of the service never
waits for it. The provider takes this path only when the daemon is the service's main process, and
only with a `systemd-run` that can leave a harness's arguments as they are, since a scope otherwise
expands each `$` reference in them. A daemon started from a shell, a test, or a session runs its
harnesses as plain children in its own cgroup.

A local harness in a scope still ends with the daemon. Each scope binds to the service, so systemd
stops the scope when the service stops or fails. systemd treats a restart of the service as its own
event, and stops no bound scope on it, so the daemon stops every scope it started as it stops, and
stops any scope an earlier run of the service left behind as it starts. Each scope's name holds the
run that started it, so the startup sweep never takes a live scope of the current run for a
leftover. Each of these stops only queues the scope's stop with systemd, so a scope that cannot
empty delays nothing but itself, and the daemon waits only for systemd to take the stops before it
exits.

## Credentials and state

A provider declares how its host supplies credentials in `credentials`, and the daemon decides each
launch from that and the agent's config ([runtime auth](./runtime-auth.md#credential-kinds)). A
provider that declares none supplies no credential.

The daemon creates `<state>/providers/<target id>/` at mode 0700 before it creates a provider, where
`<state>` is atc's state folder and `<target id>` the target's name in the config. It hands the path
to the provider's plugin as `stateDir`. For a target id that holds a path separator, `.` or `..`,
the daemon builds no provider and lists the target as unavailable with the problem.

## Binding to a target

A session binds to its target's name and its identity when it spawns, and the fleet row holds both.
A target's identity is a digest of its options, so a config change that would put the session
somewhere else changes the identity. An imp target's identity leaves out the options that never
change where a session lives, such as its image and memory size, so those can change under running
sessions. A `docker` target's identity leaves out its `image`, so a new image reaches the next
container the provider creates, a revived harness's included. A `sprites` target's identity covers
every one of its options. A fleet row with no target binds to the implicit `local` target.

A spawn without a target runs on the config's default target, and a sub-session runs on the default
too unless its spawn sets one, so a sub-session never inherits its parent's target by accident.

## The one check

Every path that starts work on a session asks one check for the session's target and the capability
the work needs: a spawn, an adopt or restore, input, an attach, a kill, an eject (a handoff to a
headless turn, which [sessions](../daemon/sessions.md#headless-handoff) covers) and a headless turn.
The daemon puts the facts a caller needs in each refusal's data:

- A config file that exists but cannot be read or parsed refuses every target, `local` included,
  with `target_config_invalid`, so a broken config never runs a session somewhere unexpected.
- A target the config does not hold is `unknown_target`, and one whose provider this daemon lacks is
  `target_unavailable`.
- A target whose identity differs from the session's binding is `target_changed`, with both
  identities.
- A host without the needed capability is `unsupported_operation`, with the provider and the
  capability.
- A remote host that cannot be created, woken or reached is `host_unavailable`, with the host's own
  error.
- A target a principal may not use is `target_forbidden` ([principals](../protocol/principals.md)).

A restore lists a session whose target the daemon cannot use as exited, and the daemon answers input
or an adopt on that session with the target's refusal. An imp binding whose identity carries no
version stays refused as changed until the provider confirms that the session's existing host is
reachable with the current credentials. The restore then records the confirmed identity on the
session.

## Starting a harness

Before a harness starts, the daemon asks the provider to ready its host. The provider creates the
remote host or wakes it, and refuses with `host_unavailable` when it cannot. The daemon waits for
that step, then starts the harness and follows its output from the first byte.

A provider is local or remote, and the two differ in what environment a harness gets. A local
harness inherits the daemon's environment, with the variables atc sets for the session on top. A
remote harness gets only those atc variables and the host's own terminal type, locale and `PATH`, so
nothing from the daemon's environment, a credential included, reaches the remote host.

An agent declares whether it can run remotely, and the daemon refuses a remote launch it cannot run
with `unsupported_operation` and the reason in the data. Two cases lead to that refusal:

- a Claude Code session on a remote host that holds no atc for its hooks;
- a gateway agent, a Claude entry with a `baseURL` of its own, whose credential helper runs on the
  daemon's machine.
