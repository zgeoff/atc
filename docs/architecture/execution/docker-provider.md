# The docker provider

The `docker` provider runs each Claude session in containers on the Docker Engine of the daemon's
own Linux machine. It uses the terms of [execution targets](./targets.md), such as host, host key,
harness, the session bridge, the relay, revive and forget. It declares these:

- `remote: true`: the harness's environment holds only the variables atc sets, as on imp.
- Every capability except `headless`, so the daemon never starts a headless session on the target.
- The credentials kind `stored-token`, which [The token](#the-token) covers.
- `hostGitIdentity`: a checkout commits as the daemon machine's git user. `cloneOnTarget` stays
  unset, so the daemon clones the workspace and transfers it.

The target's config sets `image`, `socket` (the Engine's socket), `namePrefix`, `signInVolume` and
`guestDir`, the folder in each container that atc's files go under.

The provider bind-mounts files from the daemon's machine into each container, and runs the daemon's
own compiled Linux binary there. So the Engine must run on the daemon's machine itself, outside a VM
such as Docker Desktop's, and the daemon lists a `docker` target as unavailable with the problem
`compiled_binary_required` when it runs from source.

The provider runs Claude only, because the sign-in volume holds a Claude token. The daemon refuses
an agent that names no sign-in file, such as Codex, with the problem `sign_in_unsupported`.

## The objects on the Engine

A session's host is a named volume that holds the agent's home folder and the workspace. Each
harness is the main process of a container on that volume. Beside it runs a relay sidecar, a
container whose main process is `atc relay-mux`. The daemon attaches to the sidecar, and carries the
session bridge over that attach through `openStreamRelay`.

| Object              | Name                             | Mounted at                          |
| ------------------- | -------------------------------- | ----------------------------------- |
| the host volume     | `<namePrefix><host key>`         | the home folder of the image's user |
| the relay volume    | `<namePrefix><host key>-relay`   | `<guestDir>/relay`                  |
| the sign-in volume  | the value of `signInVolume`      | `<guestDir>/sign-in`, read-only     |
| a harness container | `<namePrefix><session id>`       |                                     |
| a relay sidecar     | `<namePrefix><session id>-relay` |                                     |

- Each harness is a container's main process, because an Engine can reattach to a container's main
  process and never to a `docker exec`. A reattach replays the screen from the container's logs.
- Each harness has a sidecar of its own, so one harness's relay never waits on another's. A
  sub-session's harness, which runs on its parent's host volume, takes a sidecar that ends with it.
- A sidecar keeps its stdin open (`OpenStdin` set, `StdinOnce` unset), so a dropped attach never
  ends the mux.
- A command or an archive unpack runs in a throwaway container of the target's image on the host
  volume. The provider tells the daemon that `<home>/.atc` on the host volume is the folder for
  transferred files, so a file outlasts the container that unpacked it.

Each container also mounts the daemon's binary read-only at `<guestDir>/bin/atc`. A harness
container mounts the host's records folder read-only at `<guestDir>/records`: the files that the
daemon writes for the agent to read. That folder sits under the target's state folder on the
daemon's machine. The relay volume is a world-writable tmpfs, so the image's user can bind the
bridge socket in it.

The provider labels every object with its target, its host and its daemon, and with the machine's
`boot_id` at the time it made the object. It acts only on objects of its own daemon, and refuses any
call on an object of another daemon, a forget included, with `host_unavailable` and the problem
`host_leased`. A host volume also carries a random host id, which the provider gives the daemon as
the host's id.

## Lifecycle

A kill on this target suspends the host: the containers pause, and the session sleeps.

- **Spawn.** `prepareHost` checks the Engine, the image and the sign-in volume, then creates the
  host and relay volumes. The harness container starts once the sidecar's relay answers.
- **Kill.** `suspendHost` pauses every running container of the host, harnesses first.
- **Revive.** The provider unpauses a paused container and attaches to it again. When the harness
  container exited, the provider removes it and starts the resume command in a new container on the
  same volume. When a sidecar stopped while its harness runs, a new sidecar replaces it, and the
  relay resets as [the relay](./targets.md#the-relay) says.
- **Forget.** `destroyHost` removes the host's containers, its volumes and its records folder. It
  keeps the sign-in volume.

After a daemon restart, the daemon asks `readHarnessFates` about each sleeping session, whose
containers a kill paused. The provider answers `kept` for a harness container that runs or is
paused, and `lost` for a missing or exited one. A paused harness cannot exit by itself, so `lost`
means a reboot or an Engine restart stopped it, and the session then lists as exited.

## The token

The sign-in volume holds one file, `claude-oauth-token`, which `claude setup-token` produced
([guide](../../guides/configuration/docker-targets.md)). The provider never puts the token in a
container's environment or command. When the harness starts, the Claude launch reads the file by its
path and exports `CLAUDE_CODE_OAUTH_TOKEN` to the harness process alone. It also points
`CLAUDE_CONFIG_DIR` at a config folder for that session on the host volume. A missing or empty file
stops the launch with exit status 78.

Every session of the target runs under this one long-lived token, and any process in any container
of the target can read it. A local session's sign-in is open only to the user's own processes. atc
accepts that trade because the token never leaves the user's machine.

The volume holds a `claude setup-token` value, which Claude Code never refreshes. A `/login`
credentials file would not work there: Claude Code replaces that file by rename and rotates its
refresh token, so sessions that shared one file would break each other's sign-in.

## Refusals

The provider refuses with `host_unavailable` and one of these problems:

| Problem               | When                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `image_missing`       | the Engine lacks the image, which the provider never pulls                                                         |
| `engine_unreachable`  | the Engine does not answer at `socket`                                                                             |
| `engine_unsupported`  | the Engine is not Linux, or runs another architecture than the daemon binary                                       |
| `sign_in_missing`     | the sign-in volume is missing, or holds no token file                                                              |
| `host_exists`         | an object of the host's name carries the labels of another host or target                                          |
| `host_leased`         | an object carries another daemon's label                                                                           |
| `image_user_unusable` | the image's user has no home folder of its own                                                                     |
| `busy`                | after a refused start, the daemon asks `suspendHost` to pause the host again, and another session still runs on it |
| `engine_error`        | the Engine answered with any other error                                                                           |
