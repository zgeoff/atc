<div align="center">
  <h1>@atcx/contract</h1>

  <p>
    <a href="https://www.npmjs.com/package/@atcx/contract"><img src="https://img.shields.io/npm/v/@atcx/contract" alt="npm version"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>
    <a href="../../docs/architecture/protocol/contract.md">The published contract</a> •
    <a href="../../docs/architecture/protocol/protocol.md">The client protocol</a>
  </p>
</div>

The schemas, constants and client a program needs to call an atc daemon and read the files it
writes.

atc hosts coding-agent sessions in a daemon. The daemon and every atc client import this package at
runtime, and atc's release job publishes it at each atc release's version. The protocol version
changes with any change to a procedure or a field, and a daemon refuses a hello that sends another
one. The major version of atc's build changes with a breaking release, and `checkDaemon` compares
it. To call a daemon from Bun:

1. Get the daemon's socket path from `resolveAtcPaths(process.env).daemonSocketPath`, which
   `@atcx/contract/light` exports.
2. Open a client on that path with `openDaemonClient`, which `@atcx/contract/client` exports.
3. Send the hello with `client.sendHello('<your program>/<its version>')`. The hello carries the
   package's `PROTOCOL_VERSION`. Expect: the daemon's answer, or a `DaemonError` with the code
   `protocol_mismatch` when the daemon speaks another protocol version.
4. Parse the answer with `HELLO_RESULT_SCHEMA.parse(answer)`, and pass the result to `checkDaemon`.
   Both come from `@atcx/contract`. Expect: the verdict `match`, with the features the daemon lacks
   in `missing`, or `older` or `newer` when the major versions differ.
5. Call a procedure, such as `client.procedures.session.list({})`. Expect: the daemon's answer, with
   the type that the request contract gives it.

## Install

The package ships an ES module with its type declarations. The client entry runs on Bun only, and
every other entry also runs on Node. The install brings Zod 4, oRPC, and the xstate that the client
runs on.

```bash
bun add @atcx/contract
```

When your project type-checks the declarations of its dependencies, with `skipLibCheck` off, install
`@opentelemetry/api` beside the package. oRPC's declarations import it, and oRPC lists it only as an
optional peer:

```bash
bun add -d @opentelemetry/api
```

## Features

- **The request contract.** `DAEMON_CONTRACT`, the [oRPC](https://github.com/unnoq/orpc) contract of
  every daemon procedure, with each input and answer schema.
- **Events and records.** `DAEMON_EVENT_SCHEMA` for the event stream, and `PUBLISHED_RECORD_SCHEMA`
  for the record file the daemon writes for each session.
- **Checking a daemon.** `checkDaemon` compares the major version of the daemon's build with the
  contract's. On a match, it lists the features the daemon lacks and the ones the contract does not
  know.
- **The gateway.** atc-gateway is atc's HTTP front for several daemons. `GATEWAY_PATHS` holds the
  routes it serves, and `GATEWAY_REGISTRY_SCHEMA` parses its registry file.
- **The light entry.** `@atcx/contract/light` holds the names of the environment variables a session
  gets, the state paths, the error codes and `PROTOCOL_VERSION`. It leaves out the request contract
  and its Zod schemas, for a program that must start fast.
- **The daemon client.** `@atcx/contract/client` gives `openDaemonClient`, the client that atc's own
  processes run. The client gives each procedure's answer its type from the request contract.

## Configuration

`CONFIG_FILE_SCHEMA` parses the top-level keys of atc's own `config.json`, and the
[configuration guide](../../docs/guides/configuration.md) describes each key.

## Documentation

[The published contract](../../docs/architecture/protocol/contract.md) covers each entry, the
client, and how the package's version moves with atc's.
