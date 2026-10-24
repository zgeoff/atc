# The published contract

A program outside atc, such as a dashboard or another agent's tooling, reads atc's protocol from one
package on npm, `@atcx/contract`, instead of keeping its own copies of the schemas. The package
holds what such a program needs to talk to a daemon and to read what a daemon writes: the request
contract, the event schema, the session record, the hello answer with its features, the error codes,
the session environment names, the state paths, and the config file's schema. The daemon and every
atc client build on the same package, so a published schema is the one the daemon serves.

## What the package holds

atc's own packages import the schemas from the contract package and never keep a copy, so the
published package and the daemon cannot drift apart. The package leaves out what only atc's own
processes use: the client and its transport, the event cursor encoding, the store, the terminal
client's helpers, and the folder that holds the daemon's restart results.

The package has a second, light entry that holds the session environment names, the state paths, the
error codes and the message sender's schema. A hook reporter starts once per event inside a session,
so it imports the light entry, which skips the request contract and the schemas it builds on.

A third entry holds the field builders the schemas parse with, which read a wrong-typed field as
absent. atc's config and hook parsers take them from it too, so one parser serves every lenient
field.

npm installs only the contract's own dependencies, Zod and oRPC's contract library, beside it.
`bun run check:reach` therefore refuses any module that either entry reaches outside the package,
and any import of another package, type-only imports included. A committed snapshot holds the
declarations the package publishes, and `bun run check:contract` fails when they differ from it, so
a change to the published types shows in the pull request that makes it.

## Checking a daemon

A client checks the daemon it talks to with the helper the package exports, which reads the hello
answer. The helper takes the major version from the daemon's build string and compares it with the
contract's own: a daemon on another major version is older or newer, and its procedures and fields
may differ from the contract's. A daemon on the same major version matches, and the helper then
lists the features the contract knows that the daemon lacks, and the ones the daemon lists that the
contract does not know.

A release that adds a capability within a major version adds a feature name, so a client finds out
what an older daemon lacks without comparing minor versions.

The check runs only after a handshake the daemon accepts. Every client sends a protocol version in
its hello, a client outside atc included, and a daemon on another version refuses the hello with
`protocol_mismatch` before the client sees any features ([versions](./protocol.md#versions)). A
client outside atc therefore sends the daemon's protocol version, and the helper's check does not
replace that match, because the protocol version changes with every answer field.

## Versions

The package's version is atc's version. Each atc release carries it in the package's manifest, and
the release job publishes the package to npm once the release is tagged
([releasing](../../runbooks/releasing.md)).
