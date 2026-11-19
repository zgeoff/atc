# Runtime auth

Each execution target's provider declares how its host supplies an agent's credential, and the
daemon decides each launch's credential from that declaration and the agent's config.
[Credential kinds](#credential-kinds) covers the four kinds. The rest of this doc covers the
`broker` kind, which imp declares.

An imp is a VM that impd runs. A session whose agent takes its credential from impd's credential
broker never holds the secret. It runs on an imp that atc binds to a set of broker grants, and the
agent gets a placeholder in place of the credential. impd's broker swaps the placeholder for the
secret on the requests the imp sends to the agent's backend. atc owns the binding: which secrets and
rules an imp may use. impd owns the secrets and enforces the grants.

[The imp provider](./imp-provider.md) covers the imp itself, and the
[brokered credentials guide](../../guides/configuration/brokered-credentials.md) covers the config.

## Credential kinds

A provider declares one of four kinds in its `credentials` field. The spawn picker's agent and
target lists use the same decision as a launch, so a client never offers a target that would refuse
the agent's launch.

| Kind           | What the host does                                                |
| -------------- | ----------------------------------------------------------------- |
| `none`         | supplies nothing; the agent signs in on the host by itself        |
| `broker`       | swaps a placeholder for the secret, as the rest of this doc says  |
| `routed`       | reaches each auth profile through a route the host's router gives |
| `stored-token` | holds the agent's token in a sign-in file on the host             |

The daemon refuses a launch in the first of these cases that holds:

1. the agent requires the broker and the host has none (`broker_required`);
2. the agent's own config sets a variable that overrides the credential, such as a base URL
   (`guest_env_conflict`);
3. a routed host gets an agent with no auth selection (`route_required`);
4. a stored-token host gets an agent with an auth selection (`auth_on_stored_token`);
5. a stored-token host gets an agent that reads no sign-in file (`sign_in_unsupported`).

A routed launch verifies its routes before it readies the host, takes the route of its profile as
the agent's endpoint with the placeholder as its token, and runs at revision 1. It records no
binding and asks for no admission, so a revoke or a rebind on a routed host answers
`unsupported_operation` with the problem `routed_auth`.

The daemon's target list sets `brokerAuth: true` on a `broker` and on a `routed` target, so a client
offers the auth profiles on both. The auth binder is the part of the daemon that records bindings
and talks to impd. When a daemon runs without one, it refuses a broker launch with
`unsupported_operation` and the problem `no_auth_binder`.

A stored-token launch records no binding either. The agent's launch reads the token from the agent's
sign-in file in the host's sign-in folder when the harness starts, and exports it to the harness
process alone, so the token never sits in a container's environment or an argument list. The Claude
launch also gives each session a config folder of its own on the host.

## The binding

The daemon records each host's binding in its state store: the imp's name and id, the secrets and
rules the binding grants, a revision and a state. Every start of a brokered session's harness asks
impd to require the broker for that process. impd refuses and runs nothing when the broker is not
ready on the imp, the imp holds no grant, the process would set its own proxy or CA variable, or the
start would join a running process that started without the requirement. That refusal is
`broker_not_ready`. An attach that reconnects to the harness carries no requirement, because impd's
exec protocol takes none on an attach, so impd never checks the broker on it. The daemon still
admits every reconnect through the binding, so a revoked or blocked binding stops the attach before
it reaches impd. An impd older than the oldest impd atc supports can ignore the requirement, so the
daemon checks impd's version first and refuses to launch on such an impd with `host_unavailable` and
the problem `impd_outdated`.

## What the broker guarantees

The daemon reaches impd's broker through the credential broker contract that the imp provider
implements in atc's own terms, so the binding logic depends only on these guarantees:

- A host's id proves that it is the host atc made. A host made again under the same name gets a new
  id, so the daemon never grants to or destroys a host whose id differs from the recorded one.
- Removing a grant the host no longer holds changes nothing, so a revoke that runs twice, or one
  that finds a grant already gone, ends where one complete revoke ends.
- Destroying a host that is already gone counts as done, so a forget that finds no host drops the
  binding.

The contract also carries the provider's own words for a refusal: the broker's display name, the
command that gives the broker a new value for a secret, and the command that upgrades a broker older
than atc supports. When the daemon maps a broker's refusal, or an agent's refusal of a sign-in, it
adds the provider's command to the error as the step the user takes. That way, atc's generic
packages name no provider's command. When a provider gives no command, the daemon sends the refusal
without a step.

## Spawning

A spawn checks everything before it writes anything, so a refused spawn leaves no binding, no imp
and no grant behind:

1. impd must be no older than the oldest impd atc supports.
2. The daemon's impd token must manage imps only inside the target's name prefix and must be able to
   grant every bound secret.
3. Each secret's kind and rules in impd must match the binding exactly.

The daemon sends every read these checks need, and the read of the imp's name, to impd in one round
trip, and still refuses in the order of the list. impd reports its version only in a full status
report, its slowest read, so the target's client caches the version it read last for a while. An
impd replaced by an older one inside that window still passes the check.

The spawn then records the binding and creates a new imp. When an imp already exists under the name,
the daemon removes the binding it recorded and refuses the spawn with `auth_runtime_exists`, so a
spawn never inherits another session's grants. Otherwise it adds every grant in parallel, and waits
for each to settle before a failed one refuses the spawn, so the cleanup never runs beside a grant
still in flight. A spawn that fails after the imp exists destroys that imp. When the daemon cannot
confirm the destroy, it answers `outcome_unknown`, and the
[idempotency ledger](../protocol/idempotency.md) keeps the request's key so it never runs again.

A launch whose binding holds an OAuth secret reads that secret's sign-in from impd before it touches
the imp, and refuses with `auth_signin_needed` when the sign-in is pending or incomplete.

## Reviving and joining

A revive, a restore, and a sub-session that joins its parent's imp check the binding again before
they touch the host or resolve a workspace: the binding must be ready, the auth profiles in use must
hash as recorded, the imp must be the one recorded, and impd must hold exactly the bound grants. The
daemon sends the reads for these checks to impd at once. atc never adds a missing grant back, since
a missing grant means someone withdrew it. A sub-session joins only a host bound to the same binding
as its own.

The binding hash covers the bound secrets and the variables the profiles set, in one current form.
An older atc release wrote two parts of a binding in another form: the old placeholder value, and
the github rules, which the broker's github secret holds itself. The daemon maps each of those to
the current form before it hashes, and it hashes the recorded binding again the same way when its
recorded hash differs. So a binding whose grants are unchanged passes the check after an upgrade
with no rebind. Once impd confirms the host and its grants, the daemon writes the current form and
hash into the binding at its revision, and a launch admission and a joining sub-session compare
against that form. Any other difference still refuses until a rebind.

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
opens. Before a revoke, a rebind or a forget records anything, it cancels every admission whose
connection has not opened yet, so that connection closes with nothing sent. A rebind that a revive
or a restore makes cancels no admission, so another harness on the host still reconnects with the
settings it launched with. The lock never spans the network, so a revoke never waits on a connection
or on impd's answer.

## Revoke and rebind

Revoking a host's grants blocks every launch on the host first, then removes each grant. A running
harness keeps running, and impd refuses its later backend requests. When atc cannot confirm that a
grant is gone, the daemon keeps the launch block in place and answers `auth_revocation_pending`, so
a half-done revoke never reopens the host.

Rebinding binds the host to its agent's current auth selection at the next revision. A rebind that
fails removes only the grants it added, keeps the old revision, and blocks launches until a rebind
succeeds. A harness reads its guest settings once, at its launch, so a harness that launched under
an older revision keeps that revision's settings. A rebind therefore returns the new revision with
every session on the host whose harness launched under an older one, and each of those sessions
shows that the new revision applies at its next launch. The rebind restarts none of them, since a
restart ends the turn a running harness is in. On an imp, an adopt of a session whose harness sleeps
inside the host ends that harness and starts a fresh one under the new revision, instead of
attaching the process that holds the old settings. A running session takes the new settings after a
stop and an adopt. A revoke and a rebind act on a host's credentials, so only the daemon's owner
principal ([principals](../protocol/principals.md)) may send them. The owner rebinds with
`atc session rebind <session_id>` or the `atc_session_auth_rebind` MCP tool. A rebind starts
nothing, so the owner then starts the session with `atc session adopt <session_id>` or
`atc_session_adopt`.

A launch whose agent takes no credential from the broker is refused while its host holds a binding
in any state, so dropping `auth` from the config never reopens a blocked host. A rebind refuses such
an agent too, since it has no selection to bind, so its session stays refused until the agent's
`auth` block is back or the owner forgets the session. A forget of the session that owns the host
blocks launches, destroys the recorded imp and drops the binding.
