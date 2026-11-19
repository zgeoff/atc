# Docker targets

A `docker` target runs each session in containers on the Docker Engine of the machine the daemon
runs on. Every session signs in with one Claude token that you store in a Docker volume once.

The daemon must be a compiled release binary, because each container runs it. A daemon run from
source lists the target as unavailable with the problem `compiled_binary_required`. The Engine must
be a Linux Engine on the same machine, and its architecture must match the binary.

## Configure the target

```json
{
  "targets": {
    "box": { "provider": "docker", "image": "ghcr.io/example/agents:1.4.0" }
  }
}
```

| Key            | Default                | What it does                                                |
| -------------- | ---------------------- | ----------------------------------------------------------- |
| `image`        | required               | the image every container runs                              |
| `socket`       | `/var/run/docker.sock` | the Engine's unix socket on the daemon's machine            |
| `namePrefix`   | `atc-`                 | the start of every container and volume name                |
| `signInVolume` | `<namePrefix>sign-in`  | the volume that holds the target's Claude token             |
| `guestDir`     | `/atc`                 | the folder inside each container that atc's mounts go under |

The image holds the Claude CLI, `sh`, `tar` and glibc, and runs as a user with a home folder of its
own. atc never pulls the image, so pull it first. A change to `socket`, `namePrefix`, `signInVolume`
or `guestDir` makes a new target, and the old target's containers and volumes stay until you remove
them with `docker`. A change to `image` reaches each container atc creates after it.

## Store the Claude token

1. Run `claude setup-token` in a container of the image, with the sign-in volume mounted. Replace
   `<image>` with the target's image and `<sign-in volume>` with its `signInVolume`, which is
   `atc-sign-in` by default:

   ```bash
   docker run --rm -it --volume <sign-in volume>:/sign-in <image> claude setup-token
   ```

   Expect: a sign-in link, and after you approve it, a token that starts with `sk-ant-`.

2. Write the token into the volume. The command reads the token from your terminal until you press
   Ctrl-D:

   ```bash
   docker run --rm -i --user root --volume <sign-in volume>:/sign-in --entrypoint sh <image> \
     -c 'umask 022 && tr -d "\n" > /sign-in/claude-oauth-token'
   ```

   Paste only the token, then press Ctrl-D.

The token bills against your Claude subscription and lasts one year. Run both steps again to replace
it. A spawn on the target fails with the problem `sign_in_missing` while the volume is missing or
holds no `claude-oauth-token`.

## What a kill and a forget do

A kill pauses the session's containers, and a revive unpauses them. A forget removes the session's
containers, its volumes and its records folder, and keeps the sign-in volume. After a reboot, a
sleeping session lists as exited with the message `host lost the process`, and a revive starts the
resume command in a new container. The
[architecture doc](../../architecture/execution/docker-provider.md) covers the objects and the
refusals.
