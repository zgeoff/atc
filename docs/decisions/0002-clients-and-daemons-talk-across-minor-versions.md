# 0002: Clients and daemons talk across minor versions

- Date: 2026-11-20
- Status: decided

## Decision

A client and a daemon talk when their major versions match. The hello carries the client's major version, and the daemon compares it with its own. Inside one major version, every change to the request contract is additive. A new input field that changes behaviour gets a name in `DAEMON_FEATURES`, which the client checks before it sends the field. A change that is not additive raises atc's major version.

## Why

- The owner runs a local atc and a cloud atc, and the local TUI and `atc mcp --daemon` reach the cloud daemon over TCP. Under one protocol number that every contract change raised, both installs had to run the same build, and an upgrade on one machine broke the other until it upgraded too.
- A program outside atc that depends on `@atcx/contract` does not ship with atc, so a different daemon build is its normal case. stu's watcher worked around the old lock by sending the hello again with the daemon's number, which kept the lock in place but stopped it from protecting anything.
- `checkDaemon` and the hello's feature list already held the rule for a match by major version and the features a release adds. The old lock was the only gate that ignored them.
- A peer already ignores a field it does not know, in a request or in an answer, so additive changes work across builds with no other change to the daemon.

## Rejected alternatives

| Option | Why not |
| ------ | ------- |
| one protocol number, compared for equality, raised by every contract change | every install that talks to another must run the same build |
| the strict lock, with an opt-in for a client to retry with the daemon's number | the opt-in passes the hello and leaves the types free to disagree with the daemon's answers |
| a match by major version only for outside clients, which send no number, and the strict lock for atc's own | atc's own clients reach remote daemons over TCP, so the lockstep between local and cloud installs stays |

## Consequences

- A release that removes or renames a procedure or a field is a major release.
- A new answer field is optional in its schema, because an older daemon never sends it.
- A new procedure that an older daemon lacks fails with `unknown_method` when a client calls it.
- `bun run check:contract-compat` fails a pull request that makes a change that is not additive inside a major version.
