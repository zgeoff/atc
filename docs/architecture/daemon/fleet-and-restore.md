# Fleet and restore

A session is data, not a process. Each agent CLI streams its transcript to disk as it works, so when
the daemon stops and its local harnesses die with it, every session can come back: the next daemon
resumes each agent session from its transcript with the agent's own resume command. The fleet is the
daemon's stored list of sessions that makes this possible, one row per session, and a restore is the
step that turns those rows back into live sessions.

[Sessions](./sessions.md) covers what a live session holds, and [restart](./restart.md) covers a
deliberate daemon replacement that ends in a restore.

## The state store

The daemon keeps the fleet, the [event trail](../protocol/events.md), the
[inbox](../protocol/messages.md), the [idempotency keys](../protocol/idempotency.md) and the rest of
its state in one SQLite file, `atc.db`, in WAL mode. One connection serves the whole daemon, and a
queue orders every query and transaction behind the one in flight, so the daemon has no write races
between its own parts. Only the daemon opens the file.

## The fleet

A fleet row is keyed by the atc session id and holds what a restore needs: the agent and its agent
session id, the target and its bound identity, the directory, the parent link, the spawn prompt, the
model and effort, the transcript path and the latest result. The spawn prompt and the latest result
survive a restore because the row holds them.

A row exists from the moment a session spawns, before its agent reports an agent session id, so a
session killed before its first exchange persists too. It restores as exited, since its agent has
nothing on disk to resume. When a resume gives a second session the same agent session id on the
same target, the row written last replaces the earlier one, and so does a later row that resumes an
exited session. A live row on another target stays beside the later one, because that target may
still run its session, and atc must keep it to settle the messages the session holds. The write
relinks the rows it keeps so the fleet stays one level deep: a link to a replaced row moves to the
row that replaced it, and a row whose parent is gone or would form a cycle becomes top-level.

The daemon writes the fleet as sessions change, so a crash leaves a restorable fleet. A spawn, a
kill, an attach or a new agent session id rewrites every row this daemon lists, and a hook report
that changes nothing else updates its session's row alone. A death the owner never asked for
rewrites nothing, so the last known fleet survives it. A killed session persists as an exited row
until a second kill or a forget removes it. A rewrite leaves alone every row the daemon has not
restored yet, so a spawn or a rename before the restore keeps the stored fleet intact.

The store also records which daemon owns each row, by the daemon id minted into the store when the
daemon first opened it, and a restore loads only this daemon's rows.

## Restoring the fleet

A daemon restores the fleet itself once it is listening, unless the config turns that off, and a
client can ask for a restore at any time. The daemon keeps one restore in flight: a request that
arrives during one joins it and starts nothing. A later request, after it finishes, revives every
session that died since and every session an earlier restore could not start a terminal for, and
skips every live one. A live session that resumed a row's agent session on another target does not
stand for that row, because the fleet keeps a live row on each target, so the row still restores. A
headless turn makes such a session live, so a later restore never starts a terminal beside the turn.

1. **Register every row.** Each row becomes a session without a terminal before any process starts,
   so every client lists the whole incoming fleet at once, marked "waiting to restore". A row whose
   session is still listed, dead, revives that session in place instead of listing the id twice. An
   exited row only registers, and stays exited until the owner revives it.
2. **Order the boots.** Top-level sessions boot before their sub-sessions, and within each group the
   session with the latest event in the trail boots first, so the sessions the owner was working in
   come back before long-idle ones.
3. **Stagger the terminals.** The first session gets its terminal at once, so the caller can attach.
   Each later one waits until the session before it reports that its agent started, or until a
   per-session cap passes, so a restore after an upgrade never starts every agent at the same
   instant, and a session that never reports cannot hold up the rest.
4. **Resume each agent.** The adapter builds the resume command for the stored agent session id, and
   the session comes back under its stored atc session id, so a client that held the id before the
   restart reaches the same session after it. A terminal starts at a default size until the first
   attach resizes it.

A row whose agent id the config no longer registers keeps its place and refuses to revive, so a
backend dropped from the config never comes back as plain Claude. A row whose target cannot run it
restores as exited, and a revive answers with the target's refusal. One row that fails to register
or revive is logged and skipped, so it never keeps the rest of the fleet down. A session whose
revive fails lists the reason in place of "waiting to restore", so a restart report and the session
list show why it has no terminal. A refusal that a rebind or a later adopt clears, such as a host
whose auth profiles changed, lists with the `atc session` commands and MCP tools that clear it
([runtime auth](../execution/runtime-auth.md#revoke-and-rebind)). When the refusal is one the host
can lift by itself, such as an imp that cannot take a lease yet, the restore tries that session
again after a delay, a few times, once the rest of the fleet is through.

Between registering and getting its terminal, a session holds no pseudo-terminal: it lists as
"waiting to restore", and its descriptor reads as a running headless session. Input sent to a Claude
Code session in that window starts a headless turn rather than waiting for the terminal. The restore
then starts no terminal for that session, and it checks again after each wait while a host wakes.

## What each failure costs

- **A client crashes.** Nothing: the daemon keeps every session running.
- **The daemon stops or crashes.** Every local harness dies with it, and its in-flight turn is lost.
  The next daemon restores each session from its transcript under the same id. Remote harnesses keep
  running, and the next daemon attaches to them again.
- **A hook report is lost while no daemon runs.** The session's attention is stale until its next
  report.
- **A session dies on its own.** It lists as exited, and the fleet keeps its row, so a revive
  resumes it from its transcript.
