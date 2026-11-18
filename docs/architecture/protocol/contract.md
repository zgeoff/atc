# The published contract

A program outside atc, such as a dashboard or another agent's tooling, calls a daemon and parses the
events and session records it writes with one package on npm, `@atcx/contract`. The daemon and every
atc client import the same package, so a published schema is the one the daemon serves. The package
holds:

- the request contract, the oRPC contract of every daemon procedure;
- the event schema, the session record schema, and the schema of the answer to `daemon.hello`;
- the error codes and the protocol version;
- the names of the environment variables a session gets, and the paths of the daemon's sockets and
  state;
- the config file's schema;
- the gateway's route table and registry schema;
- atc's own daemon client.

## Entries

| Entry                   | What it holds                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@atcx/contract`        | everything in the light entry, plus the request contract, the schemas, `checkDaemon` and the gateway's tables                        |
| `@atcx/contract/light`  | the session's environment variable names, the state paths, the error codes, `PROTOCOL_VERSION`, and the schema of a message's sender |
| `@atcx/contract/schema` | the field builders                                                                                                                   |
| `@atcx/contract/client` | atc's daemon client, with `PROTOCOL_VERSION`                                                                                         |

A hook reporter starts once per event inside a session, so it imports the light entry, which leaves
out the request contract and the Zod schemas it builds on.

A field builder makes the Zod schema of one optional field. The schema parses a value of the wrong
type as `undefined` and never fails the parse. atc's config and hook parsers build their fields with
the same builders, so a field parses the same way in every parser.

## What stays out of the package

atc's own packages import the schemas and the client from the contract package and keep no copy of
them. The package leaves out the parts that only atc's own processes use: the transport that
reconnects atc's clients, the encoding of the cursors that page through events, the state database,
the terminal client's helpers, and the folder of the daemon's restart results.

npm installs every dependency of the package with it, the client's included, even for a program that
never imports the client. A module that the package's entries import must therefore sit inside the
package, and may import only the packages its manifest lists, type-only imports included.
`bun run check:reach` fails on any other import. A committed snapshot holds the declarations the
package publishes, and `bun run check:contract` fails when they differ from it, so a change to the
published types shows in the pull request that makes it.

## The gateway's tables

A program that deploys atc-gateway, atc's HTTP front for several daemons
([the gateway](../remote/gateway.md)), reads two tables from the package. The route table groups the
gateway's paths by who requests them: a person's browser, a machine client, or a health check from
the platform that runs the gateway. An ingress can then put the browser routes behind a sign-in and
keep the health checks off the public origin. The registry schema holds every rule the gateway
applies to its registry file, so a deploy tool refuses a bad registry before the gateway reads it.
The gateway and `atc mcp --http` route by the same table, and the gateway parses its registry with
the same schema.

## The client entry

Run `@atcx/contract/client` under Bun. The client connects with `Bun.connect`, and its outbound
queue relies on a Bun socket's `write()` returning the bytes it took. Under Node, the import of the
entry succeeds, and a call of `openDaemonClient` fails.

The entry holds the client that atc's terminal client, MCP server and gateway run. It writes one
JSON message per line, and queues what the socket does not take at once.

`openDaemonClient` takes a unix socket path or a TCP address. A program on the daemon's machine
passes `resolveAtcPaths(process.env).daemonSocketPath`, from the light entry. The `socketPath`
beside it belongs to the hook reporters, and a hello sent there gets no answer. A daemon that
listens on TCP takes a bearer token and a principal in the hello's options
([principals](./principals.md#the-tcp-listener)).

`sendHello` sends the package's `PROTOCOL_VERSION`, and `procedures` holds one typed function per
daemon procedure.

## Checking a daemon

Send the package's `PROTOCOL_VERSION` in the hello. The client entry does this for you, and a client
of your own sends the same number. A daemon on another protocol version refuses the hello with
`protocol_mismatch` ([versions](./protocol.md#versions)). The error's data holds the daemon's
version as `daemonProtocol`.

A protocol bump is not a major version bump, so a caller on a caret range can install a
`PROTOCOL_VERSION` that its running daemon does not speak. Pin the package's exact version to the
atc release you run. On a refusal, compare `daemonProtocol` with `PROTOCOL_VERSION`: the side with
the lower number is behind, atc or your program's copy of the package, and that side upgrades.

After the daemon accepts the hello, parse its answer with `HELLO_RESULT_SCHEMA`, and pass the result
to `checkDaemon`. The hello resolves with an untyped record, which `checkDaemon` does not take. The
package's version is atc's version ([versions](#versions)), so the helper compares the major version
of the daemon's build, in the answer's `daemon` field such as `atc/7.17.0`, with its own. Equal
protocol versions mean the daemon serves the procedures and fields the client sends, and equal major
versions mean the daemon runs the release line the contract describes.

| Verdict      | When                                 | Fields                         |
| ------------ | ------------------------------------ | ------------------------------ |
| `match`      | the major versions are equal         | `missing`, `added`             |
| `older`      | the daemon's major version is lower  | `daemonMajor`, `contractMajor` |
| `newer`      | the daemon's major version is higher | `daemonMajor`, `contractMajor` |
| `unreadable` | the build names no major version     | `daemon`                       |

On `match`, `missing` lists the features the contract knows that the daemon lacks, and `added` lists
the ones the daemon gives that the contract does not know. Each atc release that adds a capability
within a major version adds a feature name to the hello's `features`, so a client finds out what an
older daemon lacks without comparing minor versions. For example, a daemon that lists `session.host`
gives the VM host that a session runs on in each session descriptor.

## Versions

The package's version is atc's version. Each atc release carries it in the package's manifest, and
the release job publishes the package to npm once the release is tagged
([releasing](../../runbooks/releasing.md)).
