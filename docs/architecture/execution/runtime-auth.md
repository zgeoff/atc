# Runtime auth

A session whose agent takes its credential from impd's credential broker never holds the secret. It
runs on an imp that atc binds to a set of broker grants, the agent gets a placeholder in place of
the credential, and impd's broker swaps the placeholder for the secret on the requests the imp sends
to the agent's backend. atc owns the binding: which secrets and rules an imp may use. impd owns the
secrets and enforces the grants.

[The imp provider](./imp-provider.md) covers the imp itself, and the
[brokered credentials guide](../../guides/configuration.md#brokered-credentials) covers the config.

## The binding

The daemon records each host's binding in its state store: the imp's name and id, the secrets and
rules the binding grants, a revision and a state. Every start of such a session's harness, and every
attach that reconnects to one, asks impd to require the broker for that process. impd refuses and
runs nothing when the broker is not ready on the imp, the imp holds no grant, the process would set
its own proxy or CA variable, or an attach would join a process that started without the
requirement. That refusal is `broker_not_ready`. An impd too old to understand the requirement would
ignore it, so the daemon reads impd's features first and refuses to launch on such an impd with
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

The spawn then records the binding, creates a new imp, and adds each grant. An imp that already
exists under the name refuses the spawn, so a spawn never inherits another session's grants. A spawn
that fails after this point takes back the imp it created, and a take-back it cannot confirm answers
`outcome_unknown` under an idempotency key.

A launch whose binding holds an OAuth secret reads that secret's sign-in from impd before it touches
the imp, and refuses with `auth_signin_needed` when the sign-in is pending or incomplete.

## Reviving and joining

A revive, a restore, and a sub-session that joins its parent's imp check the binding again before
they touch the host or resolve a workspace: the binding must be ready, the auth profiles in use must
hash as recorded, the imp must be the one recorded, and impd must hold exactly the bound grants. atc
never adds a missing grant back, since a missing grant means someone withdrew it. A sub-session
joins only a host bound to the same binding as its own.

## Admission

Each start and attach of a brokered harness is admitted under the host's binding lock: the binding
must still be ready, or still provisioning under the spawn that launches it, and a start must match
the revision it was planned under. An admitted request goes out only once its connection to impd
opens, and a revoke, a rebind or a forget cancels every admission still waiting there before it
records anything, so the waiting connection closes with nothing sent. The lock never spans the
network, so a revoke never waits on a connection or on impd's answer.

## Revoke and rebind

Revoking a host's grants blocks every launch on the host first, then removes each grant. A running
harness keeps running, and impd refuses its later backend requests. A grant atc cannot confirm gone
leaves the launch block in place and answers `auth_revocation_pending`, so a half-done revoke never
reopens the host.

Rebinding binds the host to its agent's current auth selection at the next revision. A rebind that
fails removes only the grants it added, keeps the old revision, and blocks launches until a rebind
succeeds. A harness that is running or suspended keeps the guest settings it launched with until it
restarts, and only a harness launched after the rebind reads the new revision's settings. Both
requests act on a host's credentials, so only the owner may send them.

A launch whose agent takes no credential from the broker is refused while its host holds a binding
in any state, so dropping `auth` from the config never reopens a blocked host. Forgetting the host's
owner blocks launches, destroys the recorded imp and drops the binding.
