# 0002: Clients and daemons talk across minor versions

- Date: 2026-11-20
- Status: decided

## Decision

An atc client and an atc daemon talk when their major versions match. The major version is the first
number of atc's version, which `CONTRACT_VERSION` in `@atcx/contract` holds.

- Each client sends its major version in `daemon.hello`, the first call on every connection. The
  daemon refuses a hello from another major version with `protocol_mismatch`.
- Inside one major version, each change to the daemon's request contract is additive: a new
  procedure, a new optional field, or a new enum value. `bun run check:contract-compat` fails a pull
  request with any other change, unless the pull request marks a breaking change, which raises the
  major version.
- A new input field that changes what a call does gets a feature name in `DAEMON_FEATURES`. A daemon
  lists the feature names it serves in its hello answer, and the client checks that list before it
  sends the field.

## Why

- Before this decision, a client sent an integer, `PROTOCOL_V`, in its hello, and the daemon refused
  any value but its own. Each change to the request contract raised that number.
- The TUI on one machine drives a daemon on another over TCP, and so does `atc mcp --daemon`. Under
  the protocol number, an upgrade on one machine cut it off from the other until both ran the same
  build.
- A program outside atc that imports `@atcx/contract` ships on its own schedule, so it meets daemon
  builds other than its own. One such program, a watcher, read the daemon's number out of the
  refusal and sent the hello again with it. The retry passed the hello even when the watcher's types
  no longer matched the daemon's answers.
- `checkDaemon` in `@atcx/contract` compares major versions and lists the features a daemon lacks.
  The daemon's protocol check used neither.
- The daemon drops an input field it does not know, and every client ignores an answer field it does
  not know. Additive changes therefore work between builds of one major version.

## Rejected alternatives

| Option                                                                                           | Why not                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| one protocol number, compared for equality, raised by every change to the request contract       | every pair of installs that talk must run the same build                                                   |
| that protocol number, plus an option for a client to retry the hello with the daemon's number    | the retry passes the hello whatever the types say, so a client can misread an answer and get no error      |
| a match by major version for programs outside atc, and the protocol number for atc's own clients | atc's own clients reach remote daemons over TCP, so local and cloud installs must still run the same build |

## Consequences

- A release that removes or renames a procedure or a field is a major release.
- A new answer field is optional in its schema, because an older daemon never sends it.
- A client that calls a new procedure on an older daemon of the same major version gets
  `unknown_method`, with no check needed first.
- A new field in `daemon.hello` is a breaking change, because the client reads the daemon's features
  only from the hello answer.
