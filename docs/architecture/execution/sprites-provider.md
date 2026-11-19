# The sprites provider

The `sprites` provider runs Claude sessions on [Fly.io Sprites](https://docs.fly.io/sprites). Each
top-level session gets a sprite of its own, and each sub-session on the same target runs in its
parent's sprite, as on imp. A sprite is a persistent Linux VM. Sprites puts it to sleep when no
client is attached, and wakes it when a client runs a command in it. Sprites calls each such command
an exec. An exec is either a terminal or a plain byte stream on stdin and stdout.

This doc uses the terms of [execution targets](./targets.md): host, host key, harness, the harness
spec, a capability, a credentials kind, a problem, `prepareHost`, kill, revive and forget. A problem
is the short code that a refusal carries beside its error code, such as `host_exists` beside
`host_unavailable`.

The provider declares these:

- `remote: true`: the harness's environment holds only the variables atc sets, as on imp.
- Every capability except `headless`, so the daemon never starts a headless session on the target.
- The credentials kind `routed`: Sprites adds the credential to each request outside the sprite,
  through a connector. A connector is a Sprites object that holds a credential and forwards requests
  to one API. [Decision 0001](../../decisions/0001-sprites-credentials-through-connectors.md) gives
  the reasons.

The provider reaches Sprites through `SpritesPort`, an interface of its own. One adapter serves it
against the real API: it uses the `@fly/sprites` SDK for the REST calls and for the file endpoint,
which reads and writes a file in a sprite over HTTP. An in-memory fake serves the tests.

## When the target is unavailable

Each sprite runs the daemon's compiled binary, which the provider uploads. The daemon lists a
`sprites` target as unavailable in two cases:

- The daemon runs from source. The problem is `compiled_binary_required`.
- The target's `tokenEnv` variable is unset or empty, or its `tokenFile` is missing or empty. The
  problem holds the variable's name or the file's path, and never the token.

## Files in a sprite

The sprite's name is the target's `spritePrefix` followed by the host key. `guestDir` is the folder
in the sprite that holds atc's files, `/home/sprite/.atc` by default.

| File             | Path                                       | Holds                                                                        |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| the host record  | `<guestDir>/host.json`                     | the target id, the host key, and the id of the daemon that made the host     |
| an exec record   | `<guestDir>/state/<atc session id>.json`   | the exec ids of the session's harness and relay, each with its boot id       |
| the atc binary   | `<guestDir>/bin/atc`, with `bin/atc.build` | the daemon's compiled binary, and the build it came from                     |
| the relay folder | `<guestDir>/relay/`                        | the socket and the outbox of the relay, which [The execs](#the-execs) covers |
| a read-only file | `<guestDir>/records/<path>`                | a file that the daemon writes for the agent to read, with mode 0444          |

The provider takes a sprite of the host's name as the host only when its host record matches the
target and the host key. `prepareHost` and a forget refuse any other sprite of that name with
`host_unavailable` and the problem `host_exists`, so the provider never uses or deletes a sprite
that someone else made.

The mode 0444 guards only against a mistake. Sprites gives a sprite one user, who owns the read-only
files, so the agent can change their mode and overwrite them.

## Boot ids

Sprites may reuse exec ids after a sprite boots again, so the provider trusts a recorded exec id
only under the boot id it was recorded with. A sprite boots again when Sprites drops its memory
during a sleep, and it then gets a new boot id. The boot id is the content of
`/proc/sys/kernel/random/boot_id`. The provider reads it with `cat` in an exec, because the file
endpoint sends no bytes for a `/proc` file, whose size reads as 0.

## The execs

- **The harness** runs in a terminal exec. The provider records its exec id, and attaches to it
  again by that id. Sprites replays the screen on each attach.
- **The relay** carries the hook events of the agent out of the sprite. It runs `atc relay-mux` in
  an exec that is not a terminal, with `max_run_after_disconnect` set to `8760h`, a year, so the mux
  outlives every dropped WebSocket. The hooks in the sprite reach the mux through its socket in the
  relay folder. On the daemon's side, `openStreamRelay`, which
  [Providers and capabilities](./targets.md#providers-and-capabilities) covers, reads the exec's
  stdout through a `RelayLink` that the provider gives it. Sprites replays that stdout from byte 0
  on each attach, so `openStreamRelay` sends a hello and discards every byte before the mux's
  welcome. When the recorded exec is gone, or has another boot id, the link starts a new mux.
- **A short command** runs in an exec that is not a terminal. An archive upload is one, with the
  archive on its stdin.

Sprites names an exec's id `session_id`, and sends it in a `session_info` message on the WebSocket.
The SDK drops that message for an exec that is not a terminal, so the adapter speaks the exec
WebSocket itself. The file endpoint caps the size of a file, so the adapter sends a larger file,
such as the atc binary, through a short command's stdin.

## Lifecycle

- **Spawn.** The daemon checks the routes, as [Credentials](#credentials) says, before any sprite
  exists. `prepareHost` then creates the sprite, writes the host record, and uploads the binary when
  the sprite holds another build. The relay starts, and the harness starts once the relay answers.
- **Kill.** `suspendHost` detaches every exec of the host, the relay's included, and calls no API.
  Sprites puts the sprite to sleep once no client is attached, with the harness frozen inside.
- **Revive.** The provider attaches to the recorded harness exec when the sprite lists it under the
  same boot id. Otherwise it starts the command of the harness spec, which a revive sets to the
  agent's resume command.
- **Forget.** `destroyHost` deletes the sprite, which ends every exec on it.

The daemon also calls `suspendHost` after a refused start, to put back to sleep a host that the
start woke. That call passes a check that the host is idle, and the provider refuses with
`host_unavailable` and the problem `busy` when another session still runs on the host.

`readHarnessFates` reads only a sprite whose status is `running`, because a read of a sleeping
sprite could wake it. On a running sprite, a session whose recorded exec is listed under the current
boot id is `kept`, and any other is `lost`. The sessions of a sleeping sprite stay `unknown` until a
revive finds out.

## Credentials

The `secret` of each auth profile of the agent holds a connector's id. A connector's access policy
holds a name prefix, and Sprites forwards a request through the connector only from a sprite whose
name starts with that prefix.

The router, `createConnectorRouter`, reads the org's connectors once per `verifyRoutes` call. It
refuses with `auth_target_unsupported` and the problem `route_missing` in each of these cases:

- the profile's connector is missing;
- the connector's policy has no name prefix;
- `spritePrefix` does not start with the policy's prefix, so the target's sprites cannot use the
  connector.

For each profile, `readRoutes` returns the route
`<apiURL>/v1/gateway/<connector provider>/<connector id>`. `<apiURL>` is the target's `apiURL`, and
`<connector provider>` is the connector's kind as the Sprites API names it, such as `custom_api`.
The Claude adapter sets `ANTHROPIC_BASE_URL` to the route, and `ANTHROPIC_AUTH_TOKEN` to
`broker-placeholder`, which the connector replaces with the stored credential. The sprite never
holds a credential value. The daemon refuses an agent with no auth profile with
`auth_target_unsupported` and the problem `route_required`.

The config parser refuses two Sprites targets when one's `spritePrefix` starts with the other's, and
its error names both targets. Without that check, a connector for the shorter prefix would also
serve the sprites of the other target.

## Refusals

The provider turns each Sprites API error into `host_unavailable` with the API's status and message,
and strips the token from every message. A spawn past an org limit, such as the count of running
sprites, gets the same refusal with the API's message.

| Problem       | When                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `api_error`   | the Sprites API answered with an error, or did not answer                                  |
| `host_exists` | a sprite of the host's name holds no host record of this target and host key               |
| `busy`        | the daemon asks `suspendHost` to put an idle host to sleep, and a session still runs on it |

Each problem in this table comes with `host_unavailable`.
[When the target is unavailable](#when-the-target-is-unavailable) and [Credentials](#credentials)
give the other problems.
