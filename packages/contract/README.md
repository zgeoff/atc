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

The schemas and constants a program needs to talk to an atc daemon and read what it writes.

atc hosts coding-agent sessions in a daemon, and this package holds the daemon's side of the
conversation: the oRPC request contract, the event and session record schemas, the hello answer, the
error codes, the session environment names, and the paths of the daemon's sockets and state. The
daemon and every atc client build on the same package, and each atc release publishes it at its own
version. To start, resolve the daemon's socket with `resolveAtcPaths`, send `daemon.hello`, and pass
the answer to `checkDaemon` to learn whether the daemon speaks your version of the contract.

## Install

The package ships an ES module with its type declarations, for Node or Bun. It depends on Zod 4 and
oRPC's contract library.

```bash
bun add @atcx/contract
```

oRPC's declarations import `@opentelemetry/api`, which oRPC lists only as an optional peer. A
project that type-checks the declarations of its dependencies, with `skipLibCheck` off, installs it
beside the package:

```bash
bun add -d @opentelemetry/api
```

## Features

- **The request contract.** `DAEMON_CONTRACT`, the oRPC contract of every daemon procedure, with
  each input and answer schema.
- **Events and records.** `DAEMON_EVENT_SCHEMA` for the event stream, and `PUBLISHED_RECORD_SCHEMA`
  for the session record a session's helpers read.
- **Checking a daemon.** `checkDaemon` compares the major version in the hello answer with the
  contract's, and lists the features that differ.
- **The light entry.** `@atcx/contract/light` holds the session environment names, the state paths
  and the error codes without the request contract, for a process that starts once per event.

## Configuration

`CONFIG_FILE_SCHEMA` parses the top-level keys of atc's `config.json`, and the
[configuration guide](../../docs/guides/configuration.md) describes each key.

## Documentation

[The published contract](../../docs/architecture/protocol/contract.md) covers what the package holds
and how its version moves with atc's.
