# Runtime auth

A session whose agent takes its credential from impd's credential broker never holds the secret. It
runs on an imp that atc binds to a set of broker grants, the agent gets a placeholder in place of
the credential, and impd's broker swaps the placeholder for the secret on the requests the imp sends
to the agent's backend. atc owns the binding: which secrets and rules an imp may use. impd owns the
secrets and enforces the grants.

[The imp provider](./imp-provider.md) covers the imp itself, and the
[brokered credentials guide](../../guides/configuration/brokered-credentials.md) covers the config.

## The binding

The daemon records each host's binding in its state store: the imp's name and id, the secrets and
rules the binding grants, a revision and a state. Every start of such a session's harness asks impd
to require the broker for that process. impd refuses and runs nothing when the broker is not ready
on the imp, the imp holds no grant, the process would set its own proxy or CA variable, or the start
would join a running process that started without the requirement. That refusal is
`broker_not_ready`. An attach that reconnects to the harness carries no requirement, because impd's
exec protocol takes none on an attach. An impd too old to understand the requirement would ignore
it, so the daemon reads impd's features first and refuses to launch on such an impd with
`auth_impd_too_old`.

## What the broker guarantees

The daemon reaches impd's broker through the credential broker contract that the imp provider
implements in atc's own terms, so the binding logic depends on three guarantees and on nothing else
about impd. A host's id proves that it is the host atc made: a host made again under the same name
gets a new id, so the daemon never grants to or destroys a host whose id differs from the recorded
one. Removing a grant the host no longer holds changes nothing, so a revoke that runs twice, or one
that finds a grant already gone, ends where one complete revoke ends. Destroying a host that is
already gone counts as done, so a forget that finds no host drops the binding.

## Spawning

A spawn checks everything before it writes anything, so a refused spawn leaves no binding, no imp
and no grant behind:

1. impd must support every broker feature the binding needs.
2. The daemon's impd token must manage imps only inside the target's name prefix and must be able to
   grant every bound secret.
3. Each secret's kind and rules in impd must match the binding exactly.

The daemon sends every read these checks need, and the read of the imp's name, to impd at once, so
the checks cost one round trip, and it still refuses in the order of the list. The spawn then
records the binding, creates a new imp, and adds the grants at once. Every grant settles before a
failed one refuses the spawn, so a take-back never runs beside a grant still in flight. An imp that
already exists under the name refuses the spawn, so a spawn never inherits another session's grants.
A spawn that fails after this point takes back the imp it created, and a take-back it cannot confirm
answers `outcome_unknown` under an idempotency key.

A launch whose binding holds an OAuth secret reads that secret's sign-in from impd before it touches
the imp, and refuses with `auth_signin_needed` when the sign-in is pending or incomplete.

## Reviving and joining

A revive, a restore, and a sub-session that joins its parent's imp check the binding again before
they touch the host or resolve a workspace: the binding must be ready, the auth profiles in use must
hash as recorded, the imp must be the one recorded, and impd must hold exactly the bound grants. The
daemon sends the reads for these checks to impd at once. atc never adds a missing grant back, since
a missing grant means someone withdrew it. A sub-session joins only a host bound to the same binding
as its own.

On an imp target that sets `rebindChangedAuth`, a revive or a restore whose auth profiles no longer
hash as recorded moves the host to the current selection instead of refusing. The owner writes both
the profile change and the option, so the new grants follow the owner's own intent. The imp must
still be the one recorded and must hold every grant that both selections keep, so a withdrawn grant
still refuses. A host that also runs a session of another agent refuses as before, since two agents
that select different profiles would each move the host back on their own launches. The launch then
runs the rebind's own steps, logs one line with the host, both revisions, and the profiles added and
removed, and plans its harness under the new revision. A rebind that fails leaves the host blocked
at its old revision, and the next such launch takes back the grants the failed attempt added and
tries it again. A harness already running on the host keeps the settings it launched with, and its
session shows that the new revision applies at its next launch. A revive that finds its own harness
still inside the host from an older revision ends that process and starts a fresh one, which resumes
the conversation under the new revision's settings.

## Admission

Each start and attach of a brokered harness is admitted under the host's binding lock: the binding
must still be ready, or still provisioning under the spawn that launches it, and a start must match
the revision it was planned under. An admitted request goes out only once its connection to impd
opens, and a revoke, a rebind or a forget cancels every admission still waiting there before it
records anything, so the waiting connection closes with nothing sent. A rebind that a revive or a
restore makes cancels no admission, so another harness on the host still reconnects with the
settings it launched with. The lock never spans the network, so a revoke never waits on a connection
or on impd's answer.

## Revoke and rebind

Revoking a host's grants blocks every launch on the host first, then removes each grant. A running
harness keeps running, and impd refuses its later backend requests. A grant atc cannot confirm gone
leaves the launch block in place and answers `auth_revocation_pending`, so a half-done revoke never
reopens the host.

Rebinding binds the host to its agent's current auth selection at the next revision. A rebind that
fails removes only the grants it added, keeps the old revision, and blocks launches until a rebind
succeeds. A harness reads its guest settings once, at its launch, so a harness that launched under
an older revision keeps that revision's settings. A rebind therefore returns the new revision with
every session on the host whose harness launched under an older one, and each of those sessions
shows that the new revision applies at its next launch. The rebind restarts none of them, since a
restart ends the turn a running harness is in. On an imp, an adopt of a session whose harness sleeps
inside the host ends that harness and starts a fresh one under the new revision, instead of
attaching the process that holds the old settings. A running session takes the new settings after a
stop and an adopt. Both requests act on a host's credentials, so only the owner may send them. The
owner rebinds with `atc session rebind <session_id>` or the `atc_session_auth_rebind` MCP tool. A
rebind starts nothing, so the owner then starts the session with `atc session adopt <session_id>` or
`atc_session_adopt`.

A launch whose agent takes no credential from the broker is refused while its host holds a binding
in any state, so dropping `auth` from the config never reopens a blocked host. A rebind refuses such
an agent too, since it has no selection to bind, so its session stays refused until the agent's
`auth` block is back or the owner forgets the session. Forgetting the host's owner blocks launches,
destroys the recorded imp and drops the binding.
