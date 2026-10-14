# Session record

atc publishes one record for each session it runs. The record holds what atc vouches for about the
session. Its first field is the record scope: the workspace the session runs in and the worktrees,
branches, and pull requests a trusted caller declared. atc owns the record's format, and the session
never writes it. A reader inside the session finds the record at the path in `ATC_SESSION_RECORD`.

## Format

The record is one JSON object:

```json
{
  "format": "atc.session-record",
  "version": 1,
  "session": "8f3c2a1e-5b7d-4c9a-a2e6-1d0b3f4e5a6c",
  "daemonID": "0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30",
  "target": "local",
  "revision": 2,
  "updatedAt": "2026-10-08T09:30:00.000Z",
  "scope": {
    "workspace": {
      "path": "/home/me/src/app",
      "branch": "main",
      "repoURL": "https://github.com/me/app.git",
      "sha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    },
    "worktrees": [{ "path": "/home/me/src/app/.worktrees/fix-login", "branch": "fix-login" }],
    "branches": [{ "name": "fix-login", "repo": "/home/me/src/app" }],
    "pullRequests": [
      {
        "repo": "me/app",
        "number": 42,
        "url": "https://github.com/me/app/pull/42",
        "branch": "fix-login"
      }
    ]
  }
}
```

| Field                | Holds                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `format`             | Always `atc.session-record`.                                                                               |
| `version`            | The format version, `1`.                                                                                   |
| `session`            | The atc session id, the value of `ATC_SESSION_ID`.                                                         |
| `daemonID`           | The id of the daemon that hosts the session.                                                               |
| `target`             | The execution target the session runs on.                                                                  |
| `revision`           | A count that starts at 1 and grows by one with each change to the record.                                  |
| `updatedAt`          | When atc last changed the record, as an ISO 8601 UTC time.                                                 |
| `scope.workspace`    | The session's directory, its branch, and, for a materialized workspace, the repository URL and the commit. |
| `scope.worktrees`    | Each declared worktree's top-level path and the branch atc read from it.                                   |
| `scope.branches`     | Each declared branch and the repository directory atc found it in.                                         |
| `scope.pullRequests` | Each declared pull request, its GitHub repository as `owner/name`, its URL, and its head branch.           |

`scope.workspace.branch` is null for a detached checkout or a directory outside git. Its `repoURL`
and `sha` are null for a session that runs in a directory as it stands. A worktree's `branch` is
null when the worktree is detached.

A reader ignores the keys it does not know. atc adds keys within a version, and raises `version`
only for a change that a version 1 reader would misread. Fields about who started the session and
who sent it work sit at the top level beside `scope` when atc records them.

## Declaring scope

`session.spawn` takes `scope` on every target, and `session.scope.add` adds to the scope of a
session that exists. Both take the same object:

```json
{
  "worktrees": [{ "path": "/home/me/src/app/.worktrees/fix-login" }],
  "branches": [{ "name": "fix-login", "repo": "/home/me/src/app" }],
  "pullRequests": [{ "number": 42, "repo": "me/app" }]
}
```

atc checks each entry against the session's host before it records it:

- A worktree `path` must be the top level of a git work tree.
- A branch must exist in `repo`, as a local branch or as a branch of the `origin` remote. `repo`
  defaults to the session's directory.
- A pull request must belong to `repo` on GitHub, which atc asks through `gh`. `repo` defaults to
  the GitHub repository of the workspace's `origin`.

atc refuses a key the object does not define, and an entry that fails its check, with
`scope_invalid`. The refusal's message and `data.entry` hold the entry, such as `scope.branches[1]`.
A refused spawn starts nothing, and a refused `session.scope.add` leaves the record as it was. An
entry the record already holds changes nothing. atc never removes an entry.

## Delivery

The daemon's state store holds each record, and every provider places a copy where the session reads
it. atc writes the copy before each harness start, so a revive or a restored fleet finds it in
place, and rewrites it on every change.

| Provider    | `ATC_SESSION_RECORD`                        | Protection                                                                                                                                    |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-pty` | `<state dir>/records/<session>.json`        | The file is mode 0444 in a directory of mode 0700.                                                                                            |
| `imp`       | `/run/imp/files/atc/records/<session>.json` | impd's read-only files: a plain write fails with `EROFS`, as root too, but root with `CAP_SYS_ADMIN` can remount `/run/imp/files` read-write. |

atc replaces the file through a rename, so a reader never sees a half-written record. On an imp, atc
hands the copy to impd, whose agent keeps it outside the imp's container and shows it there on a
read-only mount
([read-only files](https://github.com/zgeoff/imp/blob/main/docs/architecture/guest/agent.md#read-only-files)).
An impd without read-only files, or an imp whose agent booted before them, has no such mount, so atc
places the copy at `<guestDir>/records/<session>.json` through a command instead, owned by root and
mode 0444. A harness that started with that copy keeps its path across a revive, because the revive
reattaches to the running process, so atc keeps a guest-folder copy current beside the read-only one
until a cold boot clears the folder. A forget removes the record and its copy.

## Who may change the record

Only atc writes the record, and only a caller outside the session's tree adds scope through it. The
daemon refuses `session.scope.add` with `unauthorized` when the caller runs inside the target
session or inside a session that the target is a sub-session of. A session may add scope to its own
sub-sessions. Every message such a caller sends is from its session
([messages](../protocol/messages.md#who-a-message-is-from)).

The daemon decides which session a caller runs inside from where the caller connects:

- On the daemon's unix socket, the kernel holds the pid of the process that connected. On Linux the
  daemon reads that pid through `SO_PEERCRED` and walks its parent chain up to the nearest harness
  process that the daemon started for a live session. That session is the caller's, whether or not
  the client's `daemon.hello` gives one, so a process that drops `ATC_SESSION_ID` before it connects
  still acts as its session. A hello that gives a different session gets `unauthorized`, and the
  daemon closes the connection. A process that the walk finds in no session acts as the session its
  hello gives. When the hello gives none, it acts as the owner, and its messages carry the owner's
  label only when the hello gives an atc build
  ([who a caller is](../protocol/principals.md#who-a-caller-is)).
- A session on an imp reaches the daemon only through its
  [session bridge](./imp-provider.md#the-session-bridge), which takes no request that changes a
  record.
- A [principal](../protocol/principals.md) adds scope only to sessions within its reach.

The [events socket](../protocol/events.md#the-events-socket) takes no requests, so the walk binds
nothing on it: a process inside a session streams the same events as any other local reader, and
every action it takes still goes through a connection that acts as its session.

On a platform other than Linux, and on a Linux whose C library is not glibc, the daemon cannot read
the peer's pid. There it keeps the hello's word: a process that drops `ATC_SESSION_ID` before it
connects reaches the daemon as its owner.

The kernel check stops an agent that drops `ATC_SESSION_ID`, not a session that sets out to attack
atc. A local session runs as the daemon's user, so a process inside it can leave the parent chain:
one that forks twice and lets the middle process exit is adopted by another process, and the walk
finds it in no session. The same user can also change the mode of the local copy of the record.
Inside an imp, a write to the copy fails, root's included, but root in the container holds the
capability to remount impd's read-only mount and change the copy until atc writes it again, and it
can write the fallback copy outright. A reader that needs the record to hold against a hostile
session reads it from atc through `session.get` rather than from the copy, and a session that must
not reach the owner's reach at all runs on an imp.
