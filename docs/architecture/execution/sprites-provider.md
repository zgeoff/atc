# The sprites provider

The `sprites` provider runs each top-level Claude session in a sprite of its own, a persistent Linux
VM on [Fly.io Sprites](https://docs.fly.io/sprites). It is a remote provider (`remote: true`), so a
harness gets only atc's variables. It declares every capability except `headless`, and its
credentials kind is `routed`. The [execution targets](./targets.md) doc covers what those
declarations mean, and the [design](../../design/remote-targets/sprites.md) holds the contract it
was built to, with [decision 0001](../../decisions/0001-sprites-credentials-through-connectors.md)
for the credentials.

The compiled daemon binary runs inside each sprite, so the provider is available only when the
daemon itself is a compiled binary. A daemon run from source lists a `sprites` target as unavailable
with the problem `compiled_binary_required`. A target whose token variable is unset or empty, or
whose token file is missing or empty, lists as unavailable with the variable's name or the file's
path in the problem, and never the token.

## The objects in the Sprites org

| Object           | Name or path                                  | Holds                                         |
| ---------------- | --------------------------------------------- | --------------------------------------------- |
| the sprite       | `<spritePrefix><host key>`                    | the host                                      |
| the host record  | `<guestDir>/host.json`                        | the target id, the host key and the daemon id |
| a session record | `<guestDir>/state/<session id>.json`          | the harness exec id, the relay exec id        |
| the atc binary   | `<guestDir>/bin/atc`, with `bin/atc.build`    | the daemon's own compiled binary              |
| the bridge       | `<guestDir>/relay/<short id>.sock` and outbox | the reporters' socket, which the mux binds    |
| read-only files  | `<guestDir>/records/<path>`                   | records the daemon writes with mode 0444      |

Each session record keeps, for the harness exec and for the relay exec, the exec id and the sprite's
boot id at the time. The boot id is the content of `/proc/sys/kernel/random/boot_id`, which the
provider reads through the file endpoint. A sprite that drops its memory boots again and gets a new
id, and Sprites may reuse exec ids after that, so the provider trusts a recorded exec id only under
the boot id it was recorded with.

The agent's user owns the 0444 files, so an agent can change the mode and overwrite a record. The
host record exists so that a sprite of the right name with no matching record is never taken for a
host: `prepareHost` and a forget refuse it with `host_unavailable` and the problem `host_exists`.

## The execs

- **The harness** runs in a terminal exec. The provider records its id and attaches to it again by
  that id, and Sprites replays the screen on each attach.
- **The relay** runs `atc relay-mux` in an exec that is not a terminal, started with
  `max_run_after_disconnect` set to a year, so the mux outlives every dropped WebSocket. The
  provider's `RelayLink` attaches to the recorded exec, Sprites replays its stdout from byte 0, and
  `openStreamRelay` discards the bytes before its own welcome. When the recorded exec is gone, or
  was recorded under another boot id, the link starts a new mux.
- **Commands and archives** run in short execs that are not terminals. An archive goes in on stdin.

An exec's session id arrives in a `session_info` message on the WebSocket. The provider speaks the
exec WebSocket itself, because the SDK drops that message for an exec that is not a terminal. The
SDK serves the REST calls and the file endpoint, and a file past the endpoint's size limit, such as
the binary, goes through an exec's stdin.

## Lifecycle

- **Spawn.** The daemon reads the connectors through the router, and refuses the spawn before any
  sprite exists when a profile has no route. `prepareHost` then creates the sprite, writes the host
  record and uploads the binary when the sprite holds none of the daemon's build. The relay starts,
  and the harness starts once the relay answers.
- **Kill.** `suspendHost` detaches every exec of the host, the relay's included, and calls no API.
  The sprite goes to sleep shortly after, with the harness frozen inside.
- **Revive.** The provider attaches to the recorded harness exec when the sprite lists it under the
  same boot id. Otherwise it starts the spec's command, which a revive sets to the agent's resume
  command.
- **Forget.** `destroyHost` deletes the sprite, which ends every exec on it.

`readHarnessFates` answers only for a sprite whose status is `running`, because a client is attached
to it and a read cannot wake it. A session whose recorded exec is listed under the current boot id
is `kept`, and one that is not is `lost`. Every other session stays unknown until a revive finds
out.

## Credentials

The router, `createConnectorRouter`, reads the org's connectors once per `verifyRoutes` call. A
profile's `secret` holds a connector id. The router refuses with `auth_target_unsupported` and the
problem `route_missing` when the connector is missing, when its access policy has no name prefix, or
when `spritePrefix` does not start with that prefix. `readRoutes` returns
`<apiURL>/v1/gateway/<connector provider>/<connector id>` for each profile, which the Claude adapter
sets as `ANTHROPIC_BASE_URL`, with the placeholder token. An agent without an auth selection is
refused with `route_required`. No credential value enters the sprite.

The config refuses two Sprites targets when one's `spritePrefix` starts with the other's, and names
both targets. Otherwise a connector that admits the shorter prefix would admit the other target's
sprites too.

## Refusals

A Sprites API error reaches the caller as `host_unavailable` with the API's status and message, and
the provider strips the token from every message. A spawn past an org limit, such as the count of
running sprites, is refused the same way with the API's message.

| Problem       | When                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `api_error`   | the Sprites API answered with an error, or did not answer            |
| `host_exists` | a sprite of the host's name holds no record of a host of this target |
| `busy`        | a session still runs on the host that a sleep would detach from      |
