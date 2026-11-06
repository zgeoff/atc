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
between its own parts. Only the daemon opens the file. A backup is one more query in that queue: the
owner's backup request makes the daemon copy the whole database with SQLite's `VACUUM INTO`, which
reads one snapshot, and rename the copy into place once it is on disk.
[Backing up and restoring the daemon](../../guides/backup.md) gives the steps.

## The fleet

A fleet row is keyed by the atc session id and holds what a restore needs: the agent and its agent
session id, the target and its bound identity, the directory, the parent link, the session that sent
the spawn, the spawn prompt, the model and effort, the spawn's plugin folders, the session's atc
access, the transcript path and the latest result. The spawn prompt, the latest result and the atc
access survive a restore because the row holds them.

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
until a second kill or a forget removes it. Either one also removes the state folder of each session
it takes off the list, `sessions/<session id>/` under the state directory, unless the config turns
[cleanup](../../guides/configuration/workspaces.md#cleanup-when-you-forget-a-session) off, or atc
saw no exit of the session's process or no end of its message bridge's stop. A folder that fails to
go is logged, and the forget still succeeds. The same forget removes the session's workspace when
its work is pushed, as [workspace cleanup](../execution/workspace-cleanup.md#cleanup-on-forget)
describes. A rewrite leaves alone every row the daemon has not restored yet, so a spawn or a rename
before the restore keeps the stored fleet intact.

The store also records which daemon owns each row, by the daemon id minted into the store when the
daemon first opened it, and a restore loads only this daemon's rows.

## Restoring the fleet

A daemon restores the fleet itself once it is listening, unless the config turns that off, and a
client can ask for a restore at any time. The daemon keeps one restore in flight: a request that
arrives during one joins it and starts nothing. A request after the restore in flight finishes
revives every session that died since and every session an earlier restore could not start a
terminal for, and skips every live one. A live session that resumed a row's agent session on another
target does not stand for that row, because the fleet keeps a live row on each target, so the row
still restores. A headless turn makes such a session live, so a later restore never starts a
terminal beside the turn.

1. **Register every row.** Each row becomes a session without a terminal before any process starts,
   so every client lists the whole incoming fleet at once, marked "waiting to restore". A row whose
   session is still listed but dead revives that session in place instead of listing the id twice.
   An exited row only registers, and stays exited until the owner revives it.
2. **Order the boots.** Top-level sessions boot before their sub-sessions, and within each group the
   session with the latest event in the trail boots first, so the sessions the owner was working in
   come back before long-idle ones.
3. **Stagger the terminals.** The restore starts terminals in two lanes at the same time, in the
   boot order within each lane. A remote host can take longer to wake from sleep than a local agent
   takes to start, and with two lanes a top-level session on the daemon's own machine never waits
   for that wake.
   - The local lane holds the top-level sessions whose agent runs on the daemon's machine. The
     remote lane holds those on remote hosts. A sub-session goes in the lane of its top-level
     session, so it still starts after that session. A local sub-session of a remote session can
     thus wait for a remote wake, and it can start beside an agent the local lane starts.
   - Each lane starts its first session at once. Each later session waits until the session before
     it in the lane reports that its agent started, or until a per-session cap passes. A restore
     after an upgrade thus starts at most one agent at a time in each lane, and a session that never
     reports cannot hold up the rest.
   - A remote session whose host still runs its agent attaches to that agent. An agent that keeps
     running reports no start, so the next session in the lane starts at once.
   - The daemon answers the restore request once the first session in the boot order, from either
     lane, has its terminal or a refusal, so the caller can attach. When that session is remote, its
     wake delays the answer, and the local lane still starts its sessions meanwhile.
   - `ATC_RESTORE_BOOT_TIMEOUT_MS` sets the cap for every restore, the automatic one included, and
     `atc daemon restart` reads the same variable for its wait on the restored fleet. The cap never
     turns off: a value of 0, or one that is not a positive number, leaves the default in place.
   - The restore records the first start each terminal's agent reports, once, so a later restart
     never changes the record. The restore settles once both lanes have tried every session. The
     daemon then waits up to one more cap for the terminals that have not reported yet, and logs one
     line from the record. The line gives the rows the restore registered. For each lane, local
     first, it gives the terminals the lane started, those that attached, those whose agent reported
     a start, and the time from the restore's start to the lane's last start:

     ```text
     atc restored the fleet (registered 3; local: terminals 2, attached 0, started 2, last start 4.2s; remote: terminals 1, attached 1, started 0, last start none)
     ```

     A restore that queues no terminal, such as one with only exited rows, logs the line at once,
     with the registered count alone.
4. **Resume each agent.** The adapter builds the resume command for the stored agent session id, and
   the session comes back under its stored atc session id, so a client that held the id before the
   restart reaches the same session after it. A terminal starts at a default size until the first
   attach resizes it. A resumed agent starts no turn, so the session keeps the state of the last
   turn event its agent reported before the restart, until the agent reports again:
   - `done` after a finished turn or a prompt for input. A relaunched agent no longer shows the
     prompt. For an attached Claude agent that still shows it, the screen check moves the session to
     `needs_you` until the prompt closes, then back to `done`.
   - `running` after a submitted prompt, or when the trail holds no turn event, since the agent may
     still be inside that turn.

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
"waiting to restore", and its descriptor reads as a live headless session, in the state that step 4
gives it. Input sent to a Claude Code session in that window starts a headless turn rather than
waiting for the terminal. The restore then starts no terminal for that session. It checks for such a
turn before each try at the session, and again while the session's remote host wakes.

## What each failure costs

- **A client crashes.** Nothing: the daemon keeps every session running.
- **The daemon stops or crashes.** Every local harness dies with it, and its in-flight turn is lost.
  The next daemon restores each session from its transcript under the same id. Remote harnesses keep
  running, and the next daemon attaches to them again.
- **A hook report is lost while no daemon runs.** The session's attention is stale until its next
  report.
- **A session dies on its own.** It lists as exited, and the fleet keeps its row, so a revive
  resumes it from its transcript.
