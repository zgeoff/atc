# Codex read-signal spike

This spike asks whether the daemon's Codex App Server bridge can tell that the model has read a
delivered message, and not only that the App Server took it. It matters for one case: a turn that
ends interrupted or failed. atc delivers a message again when the model never saw it, and leaves it
unanswered when the model did, so the bridge needs a read mark that holds across a restart. Every
result below comes from Codex CLI 0.162.0 on Linux, with the App Server's v2 protocol and
`experimentalApi`, a scratch `CODEX_HOME`, and 16 short probe runs.

The answer: `rawResponse/completed` marks a read correctly while the thread stays loaded, but it
cannot be the bridge's read mark. It exists only on a thread started with `experimentalRawEvents`,
which the protocol documents as internal-only, and the thread loses the flag whenever it reloads,
including after an App Server restart. The recommendation is to mark a message read at the first
`agentMessage` or `reasoning` item that follows the message's `userMessage` item in the same turn.
That rule needs no flag, and the thread's stored turns keep the same order, so recovery after a
restart reaches the same verdict.

The [App Server bridge spike](https://github.com/zgeoff/atc/blob/55592c3/docs/design/codex-app-server-bridge/spikes/app-server/README.md)
covers the bridge design this spike builds on.

## Running the probe

[`probe.ts`](./probe.ts) drives one thread through one scenario and appends every wire message, with
its time in milliseconds since the probe started, to an NDJSON log.
[`summarize.ts`](./summarize.ts) prints a log as the timeline that each file in [`runs/`](./runs/)
holds.

1. Start an App Server with a scratch Codex home whose `config.toml` sets `approval_policy = "never"`
   and turns hooks off, so a run never reaches the owner's `~/.codex` or a live atc daemon:

   ```bash
   CODEX_HOME=<scratch-codex-home> codex app-server --listen ws://127.0.0.1:47291
   ```

2. Run one scenario. The last argument turns `experimentalRawEvents` on (`1`) or off (`0`) for a new
   thread; the fourth argument resumes an existing thread instead:

   ```bash
   bun probe.ts ws://127.0.0.1:47291 steer-stream <log-file> "" 1
   bun summarize.ts <log-file>
   ```

The scenarios are `idle`, `steer-stream`, `steer-early`, `steer-command`, `interrupt-command`,
`interrupt-stream`, `interrupt-pending`, `idle-hold`, `observe` and `list`, and the probe source
holds the prompt each one sends.

## Findings

### When Codex adds a steered message to history

A `turn/start` on a thread with an active turn returns that turn's id at once, but the message's
`userMessage` item does not appear until Codex adds the message to the thread's history. Codex does
that between two model requests, and in no run during one:

- During a streamed reply, Codex cuts the running request short. Its `rawResponse/completed`
  arrives first, then the `userMessage` item, then a new request that reads the message
  (`03-steer-stream`, `11-steer-stream-repeat`, `11-steer-early-repeat`).
- During a command, the unified exec tool returns its output early, and the `userMessage` item
  follows that output within a few milliseconds, while the command runs on (`04-steer-command`,
  `11-steer-command-repeat`).

A cut-short reply never reaches the stored turns: its `agentMessage` item gets no `item/completed`,
and `thread/turns/list` leaves it out ([`06-stored-turns.txt`](./runs/06-stored-turns.txt)). So the
`userMessage` item marks the point from which every later model item belongs to a request that read
the message. It does not mark the read itself, because an interrupt can still end the turn before
that request completes (`05-interrupt-command`, `05-interrupt-stream`).

### `rawResponse/completed` while the thread is loaded

`rawResponse/completed` holds the thread id, the turn id, the Responses API response id and its
token usage, one notification per model request. It holds nothing that matches a request to its
inputs. Its order is enough while the thread is loaded: in all 5 steer runs, the first
`rawResponse/completed` after a message's `userMessage` item came from the request that read the
message, and that request's reply showed it (`MANGO`, `PEAR`, `GUAVA`). In both interrupt runs that
came after the `userMessage` item, no `rawResponse/completed` followed it, which is the correct
unread verdict.

Every subscriber to a loaded raw thread receives the raw notifications, not only the client that
started it (`08-observer`, `08-second-client`). A `codex resume <thread-id> --remote` terminal on
such a thread rendered both turns of `10-terminal-probe` normally and showed none of the raw items.

### `rawResponse/completed` across a reload

The flag lives in the loaded thread, not in its rollout. A thread started with
`experimentalRawEvents` sent no raw notification after it reloaded, in two ways:

- `07-observer` and `07-second-client`: the App Server unloaded the thread once its last subscriber
  left, and a client that resumed it later got `userMessage`, `agentMessage` and `turn/completed`
  but no `rawResponse/completed`.
- `09-after-restart`: after the App Server restarted, `thread/resume` reloaded the thread from disk,
  and the next turn sent no raw notification.

`thread/resume` takes no raw-events option, so the bridge cannot turn the flag back on. The App
Server does not replay notifications from before a connection, and the stored turns hold no trace
of a model request, so a read that only `rawResponse/completed` showed is lost at a restart. A
daemon restart always restarts the App Server, because the App Server is the daemon's child.

`ThreadStartParams` documents `experimentalRawEvents` as "for internal use only (e.g. Codex Cloud)",
and `RawResponseCompletedNotification` calls itself an "internal-only notification". Without the
flag the App Server sends no `rawResponse/completed` at all (`02-idle-noraw`).

### The first model item after the message

A model item is an `agentMessage` or `reasoning` item. Because a cut-short reply ends before the
`userMessage` item appears, any model item whose `item/started` arrives after a message's
`userMessage` item, in the same turn, comes from a request that read the message. All 5 steer runs
fit this rule, and so do both interrupt runs, which had no model item after the message.

The rule can mark a read message unread. In `04-steer-command`, the request that read `PEAR`
returned only a poll of the running command, which the App Server sends as no item, so the first
model item came 8 s after the read. An interrupt in that window would leave the message unseen, and
atc would deliver it a second time. That error repeats a message the model read; the opposite error
would drop one it never read.

A tool item does not count. A `commandExecution` item can start in the request before the message
and complete after it, and the stored turns order items as they complete: in `05-interrupt-command`
the stored turn holds the command after `m-i2`, although the command started before it.

### The stored turns

`thread/turns/list` with `itemsView: "full"` keeps a steered message's `userMessage` item in its
place among the turn's items ([`06-stored-turns.txt`](./runs/06-stored-turns.txt)). An
`agentMessage` after it appears in both completed turns and in neither interrupted one, so recovery
reaches the verdict the live rule gave. The default `summary` view leaves steered `userMessage`
items out, so recovery must keep asking for `full`.

### An interrupt before Codex adds the message

`12-interrupt-pending` steered `m-p2` while the first request ran, then interrupted the turn before
that request ended. `turn/start` had returned the turn's id for `m-p2`, but Codex dropped the
message: no `userMessage` item appeared, the stored turn does not hold it, and the next turn's
request did not include it. The model never saw `m-p2`, so by atc's rule it is delivered again.

### Two signals that fail

- `thread/tokenUsage/updated` arrives without the flag and once per model request, but it also
  arrived with stale numbers when a turn was interrupted (`05-interrupt-command`) and when a thread
  resumed (`09-after-restart`). Either would mark an unread message read.
- The `userMessage` item alone marks a message read too early: both interrupt runs recorded the item
  and ended before any request read it.

## Recommendation

Mark a Codex message read in the bridge at the first model item after its `userMessage` item, and
use that mark only where the interrupted or failed turn decides between two outcomes:

- A message with a model item after its `userMessage` item stays unanswered with the turn's reason.
- A message with no model item after it, or with no `userMessage` item in the turn, goes back to
  queued and is delivered again, as an unseen Claude message is.

A completed turn needs no read mark: it ends with a model item after its last input, so its final
reply answers every message it holds. Recovery applies the same rule to the stored turns. Two parts
of the bridge change with it:

- The bridge matches a message to a turn by the `turn/start` result, so it holds `m-p2` in the
  interrupted turn and leaves it unanswered. The read mark must come from the `userMessage` item
  instead.
- The App Server does not deduplicate on the client message id, so a message delivered again leaves
  a `userMessage` item with its id in two turns. Recovery must settle such a message from the latest
  turn that holds the id.

Do not use `rawResponse/completed` for the read mark. A bridge that wants a live mark sooner than the
first model item could add it as a hint on a raw thread, but a restart drops the flag, and recovery
cannot reproduce the hint.

## Limits

- Every run used `model_reasoning_effort = "low"`, and none produced a `reasoning` item. The order
  of `reasoning` items against a steered message is untested.
- No run made parallel tool calls before a steer, so the claim that Codex adds a steered message
  only after every tool output of a request is untested for that case.
- A failed turn and a context compaction between the `userMessage` item and the next request are
  untested.
- `experimentalApi`, `turn/start` steering and the App Server itself are experimental, so a Codex
  upgrade can change any order above; the manual run against the pinned Codex version before a
  release covers that.

## The runs

| Run                       | Scenario                                       | Raw flag | Read mark shown           |
| ------------------------- | ---------------------------------------------- | -------- | ------------------------- |
| `01-idle-raw`             | message on an idle thread                      | on       | read, one request         |
| `02-idle-noraw`           | message on an idle thread                      | off      | no raw notifications      |
| `03-steer-stream`         | steer during a streamed reply                  | on       | read by the second reply  |
| `04-steer-command`        | steer during `sleep 12`                        | on       | read by the poll request  |
| `05-interrupt-command`    | steer during `sleep 12`, then interrupt        | on       | unread                    |
| `05-interrupt-stream`     | steer during a streamed reply, then interrupt  | on       | unread                    |
| `06-stored-turns`         | stored turns of runs 03 to 05                  | on       | same verdicts as live     |
| `07-observer`, `07-second-client` | raw thread resumed after it unloaded   | lost     | no raw notifications      |
| `08-observer`, `08-second-client` | second subscriber on a loaded raw thread | on     | both get raw events       |
| `09-after-restart`        | raw thread resumed after an App Server restart | lost     | no raw notifications      |
| `10-terminal-probe`       | terminal joined to a raw thread                | on       | terminal renders normally |
| `11-*-repeat`             | runs 03 and 04 again, plus a steer before any output | on | same verdicts         |
| `12-interrupt-pending`    | interrupt before Codex adds the steer          | on       | message dropped           |
