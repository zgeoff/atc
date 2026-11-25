# The published contract

A program outside atc, such as a dashboard or another agent's tooling, reads atc's protocol from one
package on npm, `@atcx/contract`, instead of keeping its own copies of the schemas. The package
holds what such a program needs to talk to a daemon and to read what a daemon writes: the request
contract, the event schema, the session record, the hello answer with its features, the error codes,
the session environment names, the state paths, the config file's schema, and the gateway's routes
and registry schema. The daemon and every atc client build on the same package, so a published
schema is the one the daemon serves.

## What the package holds

atc's own packages import the schemas from the contract package and never keep a copy, so the
published package and the daemon cannot drift apart. The package leaves out what only atc's own
processes use: the transport under [the published client](./client.md), the event cursor encoding,
the store, the terminal client's helpers, and the folder that holds the daemon's restart results.

The gateway's half of the package serves a program that deploys atc-gateway. The route table groups
the HTTP server's paths by who requests them: a person's browser, a machine client, or an
orchestrator's probe, so an ingress can put the browser routes behind a sign-in and keep the probes
off the public origin. The registry schema holds every rule the gateway applies to its registry
file, so a deploy tool refuses a bad registry before the gateway reads it. The gateway and
`atc mcp --http` route by the same table, and the gateway parses its registry with the same schema.

The fleet contracts serve a program that drives a fleet through a front door: `FLEET_CONTRACT` is
what atc-gateway serves at `/rpc`, and `LOCAL_FLEET_CONTRACT` is one daemon's, which `atc mcp` runs
its tools over. Each holds the procedures the MCP tools call, under the daemon's method names, with
inputs narrowed to what the tools send, the scope each procedure needs, and an error map that adds
the gateway's codes to the daemon's. [The typed fleet API](../remote/fleet-api.md) covers them.

The package has a second, light entry that holds the session environment names, the state paths, the
error codes, the message sender's schema, and the gateway's `/rpc` path and major-version header. A
hook reporter starts once per event inside a session, so it imports the light entry, which skips the
request contract and the schemas it builds on.

A third entry holds the field builders the schemas parse with, which read a wrong-typed field as
absent. atc's config and hook parsers import these builders and keep no copies of them, so a field
that one of them parses reads the same way in every parser.

npm installs only the contract's own dependencies, Zod and oRPC's contract library, beside it.
`bun run check:reach` therefore refuses any module that one of the three entries reaches outside the
package, and any import of a package other than those two, type-only imports included. A committed
snapshot holds the declarations the package publishes, and `bun run check:contract` fails when they
differ from it, so a change to the published types shows in the pull request that makes it.

## Checking a daemon

A client checks the daemon it talks to with the helper the package exports, which reads the hello
answer. The helper takes the major version from the daemon's build string and compares it with the
contract's own. An accepted hello always comes from a daemon on the same major version, because a
daemon on another one refuses the hello first, as the end of this section says. On a match, the
helper lists the features the contract knows that the daemon lacks, and the ones the daemon lists
that the contract does not know.

A release that adds a capability within a major version adds a feature name, so a client finds out
what an older daemon lacks without comparing minor versions. A daemon that lists `session.host`
reports the `host` of a session that runs on a VM host in its session descriptors.

A new input field that changes what a call does gets a feature name and an entry in
`FEATURE_INPUT_FIELDS`, which maps a method to each such field, as a dotted path for a nested one,
and the feature a daemon must list. The connection layer checks the map before it sends a call: when
a listed field is present and not `undefined`, and the daemon's hello lacks the feature, the call
fails with `feature_missing` and sends nothing. `atc mcp` advertises every tool and input whatever
the daemon serves, and returns the same error with a message to restart the daemon on a newer atc.

The check runs only after a handshake the daemon accepts. Every client sends its major version in
its hello, a client outside atc included, and a daemon on another major version refuses the hello
with `protocol_mismatch` before the client sees any features ([versions](./protocol.md#versions)).
Read which side is older from `daemonMajor` in the refusal's data, and never retry with another
value.

## Versions

The package's version is atc's version. Each atc release carries it in the package's manifest, and
the release job publishes the package to npm once the release is tagged
([releasing](../../runbooks/releasing.md)).

The first number of that version, the major version, decides which daemons a client talks to: each
client sends it in its hello, and a daemon accepts the major version of its own build
([versions](./protocol.md#versions)). Inside one major version every change to the contract is
additive. `bun run check:contract-compat` compares each procedure's input and answer schemas and the
event schema with those at the latest release tag. It fails on a removed or renamed procedure, field
or event kind, on a narrowed type or a new required field, and on a new optional input field that
has neither an entry in `FEATURE_INPUT_FIELDS` nor an entry, with its reason, in the check's list of
harmless fields. A pull request whose title, or a commit since the tag, marks a breaking change
passes every failure but the one for a new optional input field, because release-please then raises
the major version.

The check records each fleet contract under a prefix of its own, and compares it only with its own
earlier release.
