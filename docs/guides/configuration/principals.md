# Principals

A principal is a client that reaches the daemon on someone else's behalf. Each remote MCP client is
the principal of its client ID, the one `atc clients add` prints. The `principals` key sets which
targets each principal may use. The daemon's owner, which is every connection on the local socket
that gives no principal, may use every target and is never limited by this key. The
[principals architecture](../../architecture/protocol/principals.md) covers how the daemon tells
callers apart.

A principal reaches a session only on a target it may use, and only while that target holds the
identity the session is bound to. To the principal, every other session does not exist: lists and
the event trail leave it out, and a request for it gets the answer a session that never existed
gets. The spawn directory list leaves out the directories of spawns on targets the principal may not
use. A spawn to a target the principal may not use fails with `target_forbidden`. A principal may
not stop the daemon or restore the fleet.

A principal sees a session tree, a top-level session with its sub-sessions, only when it may use the
target of every session in it. Adding a sub-session on a target the principal may not use removes
the whole tree from its view, the parent included, as if the tree had been forgotten. Removing that
sub-session brings the tree back.

Event ids number the daemon's whole trail, so a principal's `events.read` shows gaps where the
events of sessions out of its reach sit. atc makes no claim of confidentiality against traffic
analysis: the gaps and the timing of what a principal sees can reveal that other sessions are
active.

Without a `principals` key, every principal may use the implicit `local` target alone: the target
named `local` whose provider is `local-pty` with no options. Such a principal never reaches another
target, nor a `local` that now holds another provider or other options. Its spawn without a target
fails with `target_forbidden` when `defaultTarget` is another target. A request over the daemon's
[TCP listener](../../architecture/protocol/principals.md#the-tcp-listener) never gets these rights:
it may act only as a principal the `principals` key lists, so a config without the key admits no TCP
request.

These legacy rights need a config that atc can read, or no config file at all. An existing
config.json that atc cannot use, because it is not valid JSON, its root is not an object, or atc
cannot read it, grants no principal any target until you fix it, since atc cannot read the
principals the file may hold.

Adding a `principals` key takes every principal it leaves out, and every principal it grants an
empty list, off every target. To keep a client on local sessions and grant it a further target, list
both under its client ID:

```json
{
  "principals": {
    "hV3kQ9xLm2Rt7YpZ4cWn8bJd6fGs1aEu": { "targets": ["local", "box"] },
    "Np5tXc8KqW2zLr7HyB4mVd9sGj3eFa6U": { "targets": [] }
  }
}
```

A grant holds target names, and it covers each target as the target stands now: change a target's
provider or options, and the sessions started on it before the change leave every principal's reach.
A `principals` that is not an object grants nothing to anyone, and an entry that is not an object
whose `targets` holds an array of target names grants nothing to that principal. The daemon prints
each such problem to stderr when it starts. The daemon reads `principals` once when it starts, so
restart it after you change the key.
