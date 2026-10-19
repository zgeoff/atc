---
name: project-code-style
description:
  atc's additions to the shared code-style skill — the function verbs only atc uses and the names
  exempt from the verb rule. Load beside code-style before writing, reviewing, or renaming any
  TypeScript in atc.
---

# atc code style

The shared `code-style` skill holds the module layout, the acronym rule, state lifecycles, and the
function-verb taxonomy. This skill holds only what atc adds to it, and it never relaxes a rule
there.

## Key rules

- [Project verbs](#project-verbs): the verbs atc adds to the shared taxonomy, each explained where
  it could be mistaken for a shared verb.
- [Exempt names](#exempt-names): geometry helpers, script entrypoints, and kysely's driver methods
  need no verb.

## Project verbs

atc adds these verbs to the shared taxonomy. A verb whose name alone could be mistaken for a shared
verb carries its meaning. A new verb goes here and into the `verbs` option of `zgeoff/function-verb`
in [`.oxlintrc.json`](../../../.oxlintrc.json) in the same PR, and `check-project-verbs.sh` fails
when the two lists differ.

- `ack`
- `acquire`: take a lease that keeps a remote host awake (`acquireLease`), as opposed to `claim`,
  which takes exclusive ownership.
- `adopt`
- `answer`
- `attach`
- `boot`
- `copy`
- `destroy`: deletes an execution host and everything on it, which nothing brings back
  (`destroyHost`), as opposed to `remove`, which deletes one record or file.
- `detach`
- `dispose`: releases every resource an object holds in one call (`SessionRuntime.dispose`), and is
  safe to call more than once.
- `draw`
- `forget`: drops a session from the fleet for good (`forgetSession`), destroying its host where its
  target can, as opposed to `remove`, which deletes one record without touching what it describes.
- `jiggle`
- `kill`
- `log`
- `materialize`: builds a resource on an execution target from a source held elsewhere, through the
  target's provider operations, and checks the result before it counts as ready
  (`materializeWorkspace`).
- `mint`: generates a new id that atc itself is the sole authority for (`mintSessionID`), as opposed
  to `to<Brand>`, which trusts an id that arrived from outside atc.
- `quit`
- `reconcile`: settles stored state that a stopped daemon left mid-change against the evidence the
  change leaves behind (`reconcileIdempotencyKeys`).
- `renew`: extend a lease that `acquire` took.
- `sanitize`: strips a resource of credentials and executable configuration in place and checks that
  none remain (`sanitizeWorkspaceClone`), as opposed to `update`, which makes no promise about what
  is left.
- `suspend`: puts an execution host to sleep with its processes kept inside it, so a later wake
  finds them as they were (`suspendHost`), as opposed to `kill`, which ends a process.
- `transfer`: moves content into an execution provider's host (`transferArchive`), as opposed to
  `write`, which persists to the daemon's own filesystem.
- `truncate`
- `yank`

## Exempt names

The verb rule skips these names. Each also sits in the `exemptNames` option beside `verbs` in
[`.oxlintrc.json`](../../../.oxlintrc.json).

- `cols`, a tiny geometry helper, like the row and box helpers below
- `rows`
- `ptyRows`
- `out`
- `boxTop`
- `boxDivider`
- `boxBottom`
- `boxRow`
- `dimRow`
- `main`, a script entrypoint
- `init`, the first of the methods kysely's `Driver` interface fixes, which
  [`BunSqliteDriver`](../../../packages/store/src/sqlite/bun-sqlite-driver.ts) implements under the
  names the library requires
- `acquireConnection`
- `beginTransaction`
- `commitTransaction`
- `rollbackTransaction`
- `releaseConnection`
