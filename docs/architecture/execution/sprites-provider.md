# The sprites provider

The `sprites` provider runs each top-level Claude session in a sprite of its own. A sprite is a
persistent Linux VM on [Fly.io Sprites](https://docs.fly.io/sprites). It sleeps when no client is
attached, and wakes when a client runs a command in it. Sprites calls each such command an exec, and
an exec is a terminal or a plain byte stream.

[Execution targets](./targets.md) and [the imp provider](./imp-provider.md) define the terms this
doc uses: host, host key, harness, the harness spec, `prepareHost`, kill, revive and forget. The
provider declares `remote: true`, so the harness's environment holds only the variables atc sets, as
on imp. It declares every capability except `headless`. Its credentials kind is `routed`: a Sprites
connector adds the credential to each request outside the sprite, as
[decision 0001](../../decisions/0001-sprites-credentials-through-connectors.md) gives the reasons
for.

The provider reaches Sprites through `SpritesPort`, an interface of its own. One adapter uses the
`@fly/sprites` SDK for the REST calls and the file endpoint, and speaks the exec WebSocket itself.
An in-memory fake serves the tests.

## When the target is unavailable

Each sprite runs the daemon's compiled binary, which the provider uploads. The daemon lists a
`sprites` target as unavailable:

- with the problem `compiled_binary_required`, when the daemon runs from source;
- with the variable's name or the file's path in the problem, when the target's `tokenEnv` variable
  is unset or empty, or its `tokenFile` is missing or empty. The problem never holds the token.

## The objects in a sprite

The sprite's name is the target's `spritePrefix` followed by the host key. `guestDir` is the folder
in the sprite that holds atc's files, `/home/sprite/.atc` by default.

| Object           | Path                                       | Holds                                                                      |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| the host record  | `<guestDir>/host.json`                     | the target id, the host key and the id of the daemon's state folder        |
| a session record | `<guestDir>/state/<atc session id>.json`   | the exec ids of the session's harness and relay, each with its boot id     |
| the atc binary   | `<guestDir>/bin/atc`, with `bin/atc.build` | the daemon's compiled binary, and the build it came from                   |
| the bridge       | `<guestDir>/relay/`                        | the socket the hooks reach the mux through, and the outbox of the reporter |
| read-only files  | `<guestDir>/records/<path>`                | the session records that the daemon writes with mode 0444                  |

The provider takes a sprite of the host's name as the host only when its host record matches the
target and the host key. `prepareHost` and a forget refuse any other sprite of that name with
`host_unavailable` and the problem `host_exists`, so a sprite that someone else made is never used
or deleted.

The agent's user owns the 0444 files, so the agent can change their mode and overwrite them. Sprites
offers no file the agent cannot change.

## Boot ids

Sprites may reuse exec ids after a sprite boots again, so the provider trusts a recorded exec id
only under the boot id it was recorded with. The boot id is the content of
`/proc/sys/kernel/random/boot_id`. The provider reads it with `cat` in an exec, because the file
endpoint sends no bytes for a `/proc` file, whose size reads as 0. A sprite that drops the memory of
a sleep boots again with a new boot id.

## The execs

- **The harness** runs in a terminal exec. The provider records its exec id, and attaches to it
  again by that id. Sprites replays the screen on each attach.
- **The relay** runs `atc relay-mux` in an exec that is not a terminal, with
  `max_run_after_disconnect` set to `8760h`, a year, so the mux outlives every dropped WebSocket.
  The provider gives `openStreamRelay` a `RelayLink` that attaches to the recorded exec. Sprites
  replays that exec's stdout from byte 0, and `openStreamRelay` discards every byte before the
  welcome frame that answers its own hello. When the recorded exec is gone, or has another boot id,
  the link starts a new mux.
- **Commands and archives** run in short execs that are not terminals, with an archive on stdin.

Sprites names an exec's id `session_id`, and sends it in a `session_info` message on the WebSocket.
The SDK drops that message for an exec that is not a terminal, so the adapter speaks the WebSocket
itself. The file endpoint caps the size of a file, so the adapter sends a larger file, such as the
atc binary, through an exec's stdin.

## Lifecycle

- **Spawn.** The daemon calls the router's `verifyRoutes`, which [Credentials](#credentials) covers,
  before any sprite exists. `prepareHost` then creates the sprite, writes the host record, and
  uploads the binary when the sprite holds another build. The relay starts, and the harness starts
  once the relay answers.
- **Kill.** `suspendHost` detaches every exec of the host, the relay's included, and calls no API.
  Sprites puts the sprite to sleep once no client is attached, with the harness frozen inside.
- **Revive.** The provider attaches to the recorded harness exec when the sprite lists it under the
  same boot id. Otherwise it starts the command of the harness spec, which a revive sets to the
  agent's resume command.
- **Forget.** `destroyHost` deletes the sprite, which ends every exec on it.

`readHarnessFates` reads only a sprite whose status is `running`, because a read of a sleeping
sprite could wake it. On a running sprite, a session whose recorded exec is listed under the current
boot id is `kept`, and any other is `lost`. The sessions of a sleeping sprite stay `unknown` until a
revive finds out.

## Credentials

Each auth profile of the agent names a connector: the profile's `secret` holds the connector's id.
The router, `createConnectorRouter`, reads the org's connectors once per `verifyRoutes` call. It
refuses with `auth_target_unsupported` and the problem `route_missing` when a profile's connector is
missing, when the connector's access policy has no name prefix, or when `spritePrefix` does not
start with that prefix.

`readRoutes` returns `<apiURL>/v1/gateway/<connector provider>/<connector id>` for each profile. The
Claude adapter sets `ANTHROPIC_BASE_URL` to that route, and `ANTHROPIC_AUTH_TOKEN` to
`broker-placeholder`, which the connector replaces with the stored credential. The sprite never
holds a credential value. The daemon refuses an agent with no auth profile with
`auth_target_unsupported` and the problem `route_required`.

The config refuses two Sprites targets when one's `spritePrefix` starts with the other's, and names
both targets. Otherwise a connector that admits the shorter prefix would admit the other target's
sprites too.

## Refusals

The provider turns each Sprites API error into `host_unavailable` with the API's status and message,
and strips the token from every message. A spawn past an org limit, such as the count of running
sprites, gets the same refusal with the API's message.

| Problem       | When                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| `api_error`   | the Sprites API answered with an error, or did not answer                     |
| `host_exists` | a sprite of the host's name holds no host record of this target and host key  |
| `busy`        | the daemon asks `suspendHost` to sleep an idle host, and a session still runs |

Each problem in this table comes with `host_unavailable`.
[When the target is unavailable](#when-the-target-is-unavailable) and [Credentials](#credentials)
give the other problems.
