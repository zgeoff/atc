<div align="center">
  <h1>@atcx/client</h1>

  <p>
    <a href="https://www.npmjs.com/package/@atcx/client"><img src="https://img.shields.io/npm/v/@atcx/client" alt="npm version"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  </p>

  <p>
    <a href="../../docs/architecture/protocol/client.md">The published client</a> •
    <a href="../../docs/architecture/protocol/contract.md">The published contract</a>
  </p>
</div>

The client of an atc daemon: `connect()` finds the local daemon, opens its socket, and returns every
daemon procedure, typed by the request contract.

atc hosts coding-agent sessions in a daemon, and atc's own terminal client, MCP server and gateway
open their daemon connections through this package. A program of your own connects the same way, on
Node or on Bun.

```ts
import { connect } from '@atcx/client';

await using atc = await connect({ client: 'build-watcher' });

const { sessions } = await atc.session.list({});
const session = sessions[0].id;

await atc.session.message({ session, text: 'the build is green', idempotencyKey: 'build-512' });

for await (const event of atc.events()) {
  console.log(event.ev);
}
```

## Install

The package ships an ES module with its type declarations, for Node 22 or later and Bun 1.3 or
later. It depends on `@atcx/contract` and two oRPC libraries.

```bash
npm install @atcx/client
```

A project that type-checks the declarations of its dependencies, with `skipLibCheck` off, installs
`@types/node` and `@opentelemetry/api` beside it. oRPC lists the second as an optional peer.

## Features

- **Every procedure.** `atc.session.list`, `atc.session.message` and the rest, with the input and
  answer types of the contract.
- **One event stream.** `atc.events()` iterates the live events, and `atc.events.read` pages through
  the stored ones from a cursor.
- **Plain errors.** Each failure is an `AtcError` with a `code` and `data`. A dropped socket rejects
  each pending call with `connection_lost`, which says whether a resend is safe.
- **No reconnect.** The client never reconnects and never resends a call. Call `connect()` again,
  and resend only what you know is safe.
- **Version checks.** `connect()` connects to any daemon of its own major version, and
  `atc.has(feature)` reports whether the daemon lists a feature.
- **A remote daemon.** Pass `address`, `token` and `principal` to connect over TCP.
- **The connection layer.** `@atcx/client/connection` holds `openDaemonConnection`, the layer under
  `connect()`, for a program that routes calls by method name.

## Documentation

[The published client](../../docs/architecture/protocol/client.md) covers how the connection works,
and [the published contract](../../docs/architecture/protocol/contract.md) covers the schemas and
the versions.
