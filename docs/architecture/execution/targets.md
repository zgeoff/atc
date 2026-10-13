# Execution targets

An execution target is a named place a session's harness runs: the daemon's own machine, or a remote
host such as an imp. Each target in the config has a provider of its kind, and the daemon starts,
feeds and ends every harness through that provider's interface, never past it. A session binds to
its target when it spawns and runs nowhere else for its whole life, so a request that cannot run on
the session's target is refused instead of falling back to the daemon's machine.

[The imp provider](./imp-provider.md) covers the one remote provider, [workspaces](./workspaces.md)
covers building a session's working directory on its target, and the
[configuration guide](../../guides/configuration.md#targets) covers setting targets.

## Providers and capabilities

The built-in `local-pty` provider runs each harness as a child process of the daemon on a
pseudo-terminal. A provider declares what its host can do, and the daemon checks the declaration
before it calls the provider:

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

### Local harnesses under a systemd service

When a systemd user service runs the daemon, the `local-pty` provider starts each harness in a
transient scope of its own, so the service's cgroup holds only the daemon. A process that a harness
leaves behind and that cannot exit, such as one stuck in an uninterruptible wait on a hung
filesystem, then keeps only its own scope stopping, and a stop or restart of the service never waits
for it. The provider takes this path only when the daemon is the service's main process, and only
with a `systemd-run` that can leave a harness's arguments as they are, since a scope otherwise
expands each `$` reference in them. A daemon started from a shell, a test, or a session runs its
harnesses as plain children in its own cgroup.

A local harness in a scope still ends with the daemon. Each scope binds to the service, so systemd
stops the scope when the service stops or fails. A restart of the service stops no bound scope, so
the daemon stops every scope it started as it stops, and stops any scope an earlier run of the
service left behind as it starts. Each scope's name holds the run that started it, so the startup
sweep never takes a live scope of the current run for a leftover. Each of these stops only queues
the scope's stop with systemd, so a scope that cannot empty delays nothing but itself, and the
daemon waits only for systemd to take the stops before it exits.

`local-pty` declares every capability except `suspend` and `destroy`, since its host is the daemon's
own machine. What a session's kill and forget do follows from these two: a target that can suspend
puts its host to sleep on a kill, and a target that can destroy its host makes a forget take a
confirm token ([sessions](../daemon/sessions.md#ending-a-session)).

## Binding to a target

A session binds to its target's name and its identity when it spawns, and the fleet row holds both.
A target's identity is a digest of its options, so a config change that would put the session
somewhere else changes the identity. An imp target's identity leaves out the options that never
change where a session lives, such as its image and memory size, so those can change under running
sessions. A fleet row with no target binds to the implicit `local` target.

A spawn without a target runs on the config's default target, and a sub-session runs on the default
too unless its spawn sets one, so a sub-session never inherits its parent's target by accident.

## The one check

Every path that starts work on a session asks one check for the session's target and the capability
the work needs: a spawn, an adopt or restore, input, an attach, a kill, an eject and a headless
turn. Each refusal holds the facts a caller needs in its data:

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

A restore lists a session whose target the daemon cannot use as exited, and input or an adopt on it
answers with the target's refusal. A binding recorded before atc versioned imp identities stays
refused as changed until the provider confirms that the session's existing host is reachable with
the current credentials, and the restore then records the confirmed identity on the session.

## Starting a harness

Before a harness starts, the daemon asks the provider to ready its host, which creates, wakes or
holds a remote host and refuses with `host_unavailable` when it cannot. The daemon waits for that
step, then starts the harness and follows its output from the first byte.

A provider is local or remote, and the two differ in what environment a harness gets. A local
harness inherits the daemon's environment, with the variables atc sets for the session on top. A
remote harness gets only those atc variables and the host's own terminal type, locale and `PATH`, so
nothing from the daemon's environment, a credential included, reaches the remote host.

An agent declares whether it can run remotely. A Claude Code session on a remote host needs an atc
inside the host for its hooks, and a gateway agent whose credential helper runs on the daemon's
machine never runs remotely; both refusals are `unsupported_operation`, with the reason in the data.
