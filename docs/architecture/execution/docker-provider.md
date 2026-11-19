# The docker provider

The `docker` provider runs each Claude session in containers on the Docker Engine of the daemon's
own Linux machine. It is a remote provider (`remote: true`), so a harness gets only atc's variables.
It declares every capability except `headless`, and its credentials kind is `stored-token`. The
[execution targets](./targets.md) doc covers what those declarations mean, and the
[design](../../design/remote-targets/docker.md) holds the contract it was built to.

The compiled daemon binary runs inside each container, so the provider is available only when the
daemon itself is a compiled binary. A daemon run from source lists a `docker` target as unavailable
with the problem `compiled_binary_required`.

## The objects on the Engine

A session's host is a named volume that holds the agent's home folder and the workspace. Each
harness is the main process of a container on that volume, with a relay sidecar beside it whose main
process is `atc relay-mux`. The daemon attaches to the sidecar and carries the session bridge over
it through `openStreamRelay`.

| Object              | Name                             | Mounted at                          |
| ------------------- | -------------------------------- | ----------------------------------- |
| the host volume     | `<namePrefix><host key>`         | the home folder of the image's user |
| the relay volume    | `<namePrefix><host key>-relay`   | `<guestDir>/relay`                  |
| the sign-in volume  | `signInVolume`                   | `<guestDir>/sign-in`, read-only     |
| a harness container | `<namePrefix><session id>`       |                                     |
| a relay sidecar     | `<namePrefix><session id>-relay` |                                     |

Each container also mounts the daemon's binary read-only at `<guestDir>/bin/atc`. A harness
container mounts the host's records folder read-only at `<guestDir>/records`. That folder sits under
the target's state folder on the daemon's machine. The relay volume is a world-writable tmpfs, so
the image's user can bind the bridge socket in it.

Every object carries the labels `atc.target`, `atc.host`, `atc.daemon` and `atc.boot` (the machine's
`boot_id` when the object was created). A container also carries `atc.session`, and a host volume
`atc.host-id`. The provider acts only on objects of its own daemon. An object of another daemon
refuses the call with `host_unavailable` and the problem `host_leased`, a forget included.

## Lifecycle

- **Spawn.** `prepareHost` checks the Engine, the image and the sign-in volume, then creates the
  host and relay volumes. The harness container starts once the sidecar's relay answers.
- **Kill.** `suspendHost` pauses every running container of the host, harnesses first.
- **Revive.** A paused container is unpaused and attached again. When the harness container exited,
  the provider removes it and starts the resume command in a new container on the same volume. When
  a sidecar stopped while its harness runs, a new sidecar replaces it and the relay resets.
- **Forget.** `destroyHost` removes the host's containers, its volumes and its records folder. It
  keeps the sign-in volume.

A harness container that runs or is paused reports `kept`. A missing or exited one reports `lost`,
so a sleeping session lists as exited after a reboot or an Engine restart. The daemon asks only
about sleeping sessions, whose containers a kill paused, and a paused harness cannot exit by itself.

## The token

The sign-in volume holds one file, `claude-oauth-token`, which `claude setup-token` produced
([guide](../../guides/configuration/docker-targets.md)). The provider never puts the token in a
container's environment or command. The Claude launch reads the file by its path when the harness
starts and exports `CLAUDE_CODE_OAUTH_TOKEN` to the harness process alone, with a
`CLAUDE_CONFIG_DIR` of the session's own on the host volume. A missing or empty file stops the
launch with exit status 78.

## Refusals

`prepareHost` refuses with `host_unavailable` and one of these problems:

| Problem               | When                                                                         |
| --------------------- | ---------------------------------------------------------------------------- |
| `image_missing`       | the Engine lacks the image, which the provider never pulls                   |
| `engine_unreachable`  | the Engine does not answer at `socket`                                       |
| `engine_unsupported`  | the Engine is not Linux, or runs another architecture than the daemon binary |
| `sign_in_missing`     | the sign-in volume is missing or holds no token file                         |
| `host_exists`         | an object of the host's name belongs to no host of this target               |
| `host_leased`         | an object belongs to another daemon                                          |
| `image_user_unusable` | the image's user has no home folder of its own                               |
| `busy`                | a session still runs on the host that a sleep would pause                    |
| `engine_error`        | the Engine answered with another error                                       |
