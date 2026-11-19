# docker-target

Check, on the `docker` verify target, that:

- a Claude session runs in Docker containers;
- no container's environment holds the Claude token;
- the session runs again after a kill and a revive;
- a forget removes the session's containers and volumes, and keeps the sign-in volume, which every
  session shares.

Run this journey after the journeys on `local`:

1. Run `docker info`. Expect: exit 0. When it fails, skip `done` for docker-target, and list it in
   your reply.
2. Run `bun verify down`. Then run `bun verify use --target docker`, `bun verify up` and
   `bun verify doctor`. Expect from `up`: `ok: true`, after about 10 seconds.
3. Run the lines of [Journey](#journey) in order. When a line exits non-zero, do what step 5 of the
   verify skill's [Check a change](../SKILL.md#check-a-change) says.
4. When you are done with this journey, run `bun verify down`. Expect: `ok: true`. `down` removes
   every container, volume and image of the run.

## What the run holds

- `up` compiles the atc binary, builds an image with a stand-in `claude`, and writes a fake token
  into the run's sign-in volume.
- `bun verify` names each Docker object of the run with one prefix, `atcverify<random>-`.
  `inspect-docker-session` reads only the objects with that prefix.
- The run's daemon has one execution target in its config, `box`, of the `docker` provider. Each
  action starts its session on `box`. The word "target" in the rest of this file means a verify
  target.
- Each session has a harness container, which runs the stand-in `claude`, and a `-relay` sidecar
  container, which carries the session's hooks to the daemon. The two share a `-relay` volume, which
  holds the socket the hooks go through.
- At start, the stand-in reads the token file in the sign-in volume, and compares the token with the
  one `up` wrote.
- On this target, a kill pauses the session's containers. `wake-docker-session` kills the session,
  revives it, and waits until the daemon lists it as running.

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

Each value sits under the command's `data`.

- Every command exits 0.
- The first `inspect-docker-session` gives two `containers`, the harness and its `-relay` sidecar,
  and three `volumes`: the session's own volume, its `-relay` volume and the sign-in volume. It also
  gives `tokenInEnv` false, and `tokenSeenByHarness` true, which means the stand-in read the token
  from the file.
- After the wake, `rows` of the `db query` holds the `wv-docker` row with `exited` 0.
- The last `inspect-docker-session` gives no `containers`, the sign-in volume alone in `volumes`,
  and `tokenInEnv` false.
