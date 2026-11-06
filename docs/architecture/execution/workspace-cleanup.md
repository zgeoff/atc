# Workspace cleanup

atc removes a workspace it built, and a session's state folder, in two places: inside a forget, and
in a prune that the owner asks for. Both run the same checks and the same removal, and neither ever
removes a directory that atc did not build. [Workspaces](./workspaces.md) covers how atc builds a
workspace and claims its directory.

## Cleanup on forget

A forget removes the workspace atc built for the session, and so does a kill of a session that has
already exited, which forgets it. atc removes only the directory that the session's ready
materialization row names on the session's own target, so a session in a directory atc did not build
never loses it. The forget answers with `workspace`: `removed` with the path and what the checks
found, `kept` with the path and one reason per check that failed, or `none`. The daemon logs every
`removed` and `kept`. The same step runs for each sub-session that the forget takes off the list,
and only the daemon log carries those outcomes.

The step runs inside the forget, once the session is off the list, on the session's host through the
provider's `runCommand`, so a sub-session in its parent's imp is checked and removed inside the imp.
It starts only once atc has seen the session's process exit. The killer and a failed spawn's
rollback each keep the handle of every harness they end, a revive between two kills included, and
the step waits for each exit, then ends a harness with a forced kill and waits once more. The step
also waits for the stop of the session's message bridge, which writes in the state folder. When a
launch still starts the bridge, the stop waits for that start, and then stops the bridge. These keep
both folders, the workspace as unchecked:

- a harness that still shows no exit;
- a harness that the host ended without an exit, such as a connection it gave up on or a host that
  went to sleep, until a new harness attaches to the session;
- a bridge stop that fails, this one or an earlier one that no later stop of the session has retried
  with success;
- a headless turn the session ever started, since the turn's runner reports no exit to wait on, and
  its result or its stop comes before its process ends.

A session id that names a folder other than its own under `sessions/`, such as one with a `..`
segment, keeps the state folder too.

One script answers seven checks. It refuses the directory when the row's path is now a symlink,
since atc never builds a workspace as one, and enters it through any symlink in a parent:

1. `git status --porcelain --untracked-files=all --ignore-submodules=none` prints nothing. An
   ignored file never counts.
2. `git ls-files -v` marks no path assume-unchanged or skip-worktree, since `git status` skips the
   edits to such a path.
3. `git stash list` prints nothing.
4. Every commit reachable from HEAD, a local branch, a tag or a notes ref is on a remote-tracking
   ref, so a commit made on a detached HEAD counts as unpushed. A tag or a notes ref that points at
   no commit, such as a tag on a tree, fails the check, since the count sees no commit behind it.
5. `git worktree list` names no linked worktree whose folder still exists. A linked worktree keeps
   its git data inside the workspace, and the other checks never look inside it.
6. The index holds no submodule, since the other checks never look inside one either.
7. The host answers. A host that fails the command keeps the directory as unchecked.

The script reads no system or global git config and turns off an fsmonitor that the repository's own
config names, since `git status` would start it. It refuses a directory that is not the top of a git
checkout holding the row's commit, and the forget then keeps it. A directory already gone gives
`none`. One table of fields in `run-workspace-check.ts`, the per-ref and detached-HEAD counts
included, writes every line the script prints and the schema that reads them. An answer that lacks
one of the five count lines, or holds a label the table does not name, keeps the directory as
unchecked. The schema takes any number of branch, tag and notes lines and at most one detached-HEAD
line, so it never notices one of those missing.

| Case                                                    | Workspace                        |
| ------------------------------------------------------- | -------------------------------- |
| `workspaces.cleanup.enabled` is `false`                 | `none`, and nothing is removed   |
| The forget destroyed the session's host                 | `none`, and no check runs        |
| No ready materialization row for the session            | `none`                           |
| atc saw no exit of the session's process                | `kept`, and both folders stay    |
| The session's target changed since it started           | `kept`, and no check runs        |
| Another listed session's directory lies inside it       | `kept`, `in use by session <id>` |
| A forgotten session not yet seen to end runs inside it  | `kept`, `in use by session <id>` |
| A check fails, under `check: "unpushed"`                | `kept`, one reason per check     |
| A check fails, under `check: "none"`                    | `removed`, with `found`          |
| The host does not answer, or the directory is not atc's | `kept`, under either check       |
| Every check passes                                      | `removed`                        |

The removal is the rollback's: it removes the contents from inside the directory while the directory
still resolves to itself, and it refuses while the directory of a listed session, of a forgotten
session not yet seen to end, or of a claim lies inside, as the host resolves each one. Each kill or
forget holds the sessions it may take off the list and releases only its own hold, so a session
stays counted while any kill or forget still waits on it. A refused or failed removal keeps the
directory with its reason. Every spawn that builds a workspace claims its directory before the clone
creates it: on a shared host as [claims and rollback](./workspaces.md#claims-and-rollback)
describes, and on the daemon's own machine from its landing. From before the check until the removal
ends, a claim on that shared host, or one on the daemon's machine that overlaps the directory, is
refused as `workspace_overlap`. So no session starts inside a directory after the check has found it
clean. The session's state folder on the daemon's host goes after the workspace step, whatever that
step decided, unless cleanup is off or atc saw no exit of the session's process.

## Prune

The owner-only `workspaces.prune` request applies the forget's checks to the folders that no session
owns. Without `remove`, it reports what it would remove and removes nothing. It covers each
configured target whose hosts have no lifecycle, and it ignores every row on another target. The
daemon reads the stored fleet and the materialization rows first. Then, in one turn, it collects the
candidates against the listed sessions, the sessions a kill or forget still holds, and the spawns in
flight. A spawn counts as in flight from its first step until it lists or its unwind ends.

A session counts as listed when the registry holds it or the stored fleet held it at the read, so a
session that no fleet restore has registered yet keeps its folders. Only a listed session on a
target without a host lifecycle can use a workspace, since another target's directory lies on
another machine. A session can reach a workspace through a symlink, so the prune resolves, once per
run, the directory of each listed session, and a dry run gives the verdict a prune with `--yes`
gives. A workspace that such a directory resolves into is `keep`, `in use by session <id>`, and so
is every workspace when one of those directories does not resolve.

- **Workspace.** A candidate is a folder that a ready row on a covered target names. It stops being
  a candidate when a listed session or a spawn in flight owns any row that names it, or when a
  listed session's directory lies inside it. The newest ready row gives the commit that the check
  needs. The prune checks and removes the folder as the forget does, under the same hold, with
  `cleanup.check`. It ignores `cleanup.enabled`. A folder already gone drops out of the answer.
- **State folder.** A candidate is a folder under `sessions/` whose name is neither a listed session
  nor a spawn in flight. The prune checks the name again just before the removal.
- **Skip.** A folder directly under a covered target's workspaces root is `skip`: `no atc record`
  when no row on a covered target names it, and `atc never finished building it` when no ready row
  does. The prune never touches a `skip` folder. A root that the host cannot list fails the prune
  with the host's error.

Each folder carries its size: `du -sk` through the provider for a workspace, and a walk that follows
no symlink for a state folder. The size is null when the host does not answer. A prune with `remove`
logs each folder it removes or keeps. The daemon never runs a prune by itself.
