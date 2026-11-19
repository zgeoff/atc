# docker-target

Check that a session runs in Docker containers on the `docker` target, keeps its token out of every
container's environment, wakes after a kill, and leaves the sign-in volume when it is forgotten.

Run this journey on the `docker` target, not `local`: `bun verify use --target docker`, then
`bun verify up` and `bun verify doctor`, as steps 2 and 3 of the verify skill's Check a change say.
It needs a Docker Engine on this machine that the user can reach through `/var/run/docker.sock`. Run
the journey's lines in order. At the first line that exits non-zero, skip to the last line, run it,
and count the feature as failed.

- `up` compiles the daemon, since a container runs the daemon's binary, builds an image on
  `debian:stable-slim` that holds a stand-in claude, and stores a fixed fake token in a sign-in
  volume. That takes several seconds. `down` removes the containers, volumes and image of the run.
- The stand-in reports its hooks through the real reporter over the relay, and writes a file when
  the token it was given matches the sign-in volume's file.
- `spawn-docker-session` starts the session on the target `box`. `wake-docker-session` kills it,
  which pauses the containers, revives it, and waits until the daemon lists it alive.
- `inspect-docker-session` lists the run's containers and volumes by name prefix.

## Journey

```bash
bun verify use --feature docker-target
bun verify action spawn-docker-session --name wv-docker
bun verify action inspect-docker-session
bun verify action wake-docker-session --name wv-docker
bun verify db query "select name, exited from fleet where name = 'wv-docker'"
bun verify action forget-docker-session --name wv-docker
bun verify action inspect-docker-session
```

## End state

- Every command exits 0.
- The first `inspect-docker-session` returns two `containers`, a harness and its `-relay` sidecar,
  three `volumes` (the host, its `-relay` volume and the sign-in volume), `tokenInEnv` false, and
  `tokenSeenByHarness` true.
- After the wake, the `db query` returns the `wv-docker` row with `exited` 0.
- After the forget, the last `inspect-docker-session` returns no `containers`, only the sign-in
  volume in `volumes`, and `tokenInEnv` false.
