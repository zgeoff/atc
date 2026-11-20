# The published client

A program outside atc, such as a dashboard or another agent's tooling, talks to a daemon through one
package on npm, `@atcx/client`. Its `connect()` finds the local daemon, opens the socket, sends the
hello and returns every daemon procedure, typed by [the published contract](./contract.md). atc's
own terminal client, MCP server, gateway and CLI open their daemon connections through the same
package, so the published client and atc's clients behave alike.

The package runs on Node 22 or later and on Bun 1.3 or later. It uses `node:net` and no Bun global.
It depends on `@atcx/contract` at `^` its own version, so a caller that also imports the contract
gets one copy of it, and on two oRPC libraries at exact versions.

## Two entries

| Entry                     | Holds                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `@atcx/client`            | `connect()`, `readDaemonSocketPaths()`, the `AtcClient` type and `AtcError`             |
| `@atcx/client/connection` | `openDaemonConnection()`, one connection to a named daemon, which `connect()` builds on |

`connect()` tries the computed socket path and then the path the daemon record holds. It never
starts a daemon: it throws `no_daemon` with every path it tried when none answers. A connection to a
remote daemon needs an `address`, a `token` and a `principal`, and `connect()` refuses an address
without them. A caller that routes calls by method name, such as the gateway, uses
`openDaemonConnection()` and its `request(method, params)`.

## What a connection does

- **Hello.** The connection sends the client's protocol version and contract major, then checks the
  answer against the contract's schema. A daemon on another major version answers
  `protocol_mismatch`, and so does an answer outside the schema.
- **Feature check.** A call whose input holds a field that a daemon feature gates fails with
  `feature_missing` before it leaves the process when the hello did not list the feature.
- **One event stream.** A connection holds one `events.subscribe` stream, opened on the first
  `events()` call. Each `events()` iterator reads from it and holds at most 10,000 unread events,
  then ends with `events_overflow`. The daemon holds the events from the hello until the first
  subscription only up to a limit, and drops them all without notice when that limit fills, so a
  caller that must not miss an event reads `events.read` with a cursor ([events](./events.md)).
- **Output cap.** A connection stops sending once its socket holds more unwritten output than the
  client allows, and the call fails with `internal`.
- **No reconnect and no resend.** A dropped socket rejects each pending call with `connection_lost`.
  Its `data` names the procedure, and says whether the call was read-only and whether it carried an
  idempotency key, which is what a caller needs to decide on a resend. See
  [idempotent requests](./idempotency.md).
- **Deadline.** The connect and the hello share `timeoutMs`, which has a default. A late hello fails
  with `timeout`, and an abort signal cancels the open.

## Errors

Every failure is an `AtcError` with a `code` and a `data` object, which is never undefined. The
codes come from `@atcx/contract/light`, and the client adds four: `no_daemon`, `connection_lost`,
`timeout` and `events_overflow`. The bearer token never appears in an error's message or data, or in
a log line.

## How atc uses it

atc's packages open a daemon connection only through `@atcx/client`. `@atc/protocol/client` wraps
`openDaemonConnection()` in the shape the older callers use: `createDaemonClient()` opens nothing,
and `sendHello` opens the connection, so a daemon that is not there fails the hello with
`no_daemon`. `atc send` calls `connect()`. A test of the daemon's own handling of an early request,
a bad hello or a foreign protocol version opens a raw client from
`@atc/protocol/test-utils/open-raw-daemon-client`, which skips the client's checks.

`bun run check:daemon-sockets` lists the files that open a socket, a `connect` import from
`node:net` among them, and fails on a new one, so a daemon connection cannot appear beside the
client. The hook, statusline and note reporters never load the client: each writes one line to the
reporter socket in `ATC_SOCKET`.

## Packing and publishing

`scripts/publish-contract.sh` packs `@atcx/contract` and then `@atcx/client`, and checks each
archive: no `catalog:` or `workspace:` range, no TypeScript source, and no import of a module the
package does not depend on. A dry run installs both archives into a Node project, type-checks a
program against them, and runs the client against a stub daemon on Node and on Bun. The release job
publishes the contract first, because the client depends on it, and skips a version that npm holds
already. `bun run check:contract` keeps one declaration snapshot for each package.
