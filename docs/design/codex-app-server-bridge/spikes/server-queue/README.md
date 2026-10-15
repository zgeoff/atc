# Codex App Server queue spike

The Codex App Server has a queue of its own for user messages, reached through the experimental
`thread/queue/*` methods. Its items survive a hard kill of the server and an update of Codex, and
the wire shape of the methods has not changed since they first shipped. The queue still cannot hold
atc messages, because it delivers on different terms: it starts a queued message only once the
thread is idle, as a turn of its own, and an interrupted turn leaves the queue waiting until a later
turn completes. atc delivers a message into the running turn and settles a message from an
interrupted turn as unanswered, so the queue would hold back messages that atc delivers at once.

The recommendation: atc keeps its own hold for Codex sessions, and the bridge keeps `turn/start`.
Every result below comes from Codex CLI 0.148.0, 0.162.0 and 0.162.1 on Linux, a scratch
`CODEX_HOME`, and short model turns, with the source of Codex 0.162.0 for the mechanism.
[Codex on an App Server](../../../../architecture/agents/agent-integration.md#codex-on-an-app-server)
covers how the bridge delivers and recovers.

## How the queue works

`thread/queue/add` takes a thread id, the input, and a `clientUserMessageId`, and stores the item in
`queue_1.sqlite` in the Codex home, beside the thread store. `thread/queue/list`, `update`, `delete`
and `reorder` change the stored items, and each change sends `thread/queue/changed` to the
subscribers of the thread. `thread/queue/start` starts one item at once, and refuses with
`thread already has an active or pending turn` when the thread is busy. The thread need not be
loaded for an add: an item for a thread that only exists on disk waits until a server loads it.

The server starts the head of the queue itself, through a hook that runs when a loaded thread goes
idle:

1. A turn completes, or an add reaches an idle loaded thread.
2. The server starts the head item as a new turn, with `queue` as its trigger and the item's
   `clientUserMessageId` as the `clientId` of the turn's `userMessage` item.
3. Once the turn has started, the server deletes the item and moves to the next one at the next
   idle.

A watcher in the same server checks the queue database every 10 s for rows another process wrote,
and for threads that a client loaded or resumed, and starts their head items the same way. The hook
returns without starting anything when the thread went idle through an interrupt, and the watcher
skips a thread whose status is interrupted.

## Restart and update

A queued item survives a server restart, a SIGKILL included. Run 01 queued three items on 0.162.0,
killed the server with SIGKILL, and listed the same three items, with the same ids, from a new
server. Run 09 killed a server on 0.162.1 while a turn ran a command with one item queued; the new
server listed the item, and the item started 0.07 s after `thread/resume`.

A queued item survives a Codex update in both directions:

- Run 06 queued two items on 0.162.0, killed the server, and started 0.162.1 on the same home. The
  new server listed both items and ran them in order after a resume, each turn carrying its message
  id as the `clientId`.
- Run 10 queued an item on 0.148.0 in a fresh home, whose queue database had only the first
  migration. 0.162.1 applied the second migration on start, listed the item and ran it.
- Run 02 opened a queue that 0.162.0 had written with 0.162.1 and then with 0.148.0, and 0.148.0
  added an item to it. Codex opens a database that a newer Codex migrated and skips the migrations
  it does not know, so a downgrade keeps the queue too.

## Delivery waits for the turn to end

A message queued during a turn waits for that turn to end, and then starts a turn of its own. In run
04 (0.148.0) the item was added 5 s into a turn that ran a 12 s command, and it started 14 s later,
18 ms after the first turn completed. The model therefore never sees the message while it works, and
a sender waits for the whole of the running turn. The bridge's `turn/start` adds a message to the
running turn instead, which the model reads at its next step, and the Claude mod does the same.

## An interrupt stalls the queue

After an interrupt, a queued item waits until some later turn completes. In run 07 (0.162.1) the
item stayed queued for 25 s after `turn/interrupt`, through a SIGKILL of the server, a restart and a
`thread/resume`, and for 40 s after the resume. Run 05 shows the same on 0.148.0. In run 08 a normal
turn started and completed on the same thread, and the item started 8 ms after it.

atc settles a message carried by an interrupted turn as unanswered, which the sender sees. A message
in the server queue gets no outcome at all until the person at the terminal starts another turn, and
nothing at the terminal shows that the message waits.

A kill differs from an interrupt. In run 09 the stored turns hold the killed turn as interrupted,
yet the item started at once after the resume, so the queue treats an explicit interrupt and a crash
differently.

## Any client's resume starts the queue

`thread/resume` from any client lets the watcher start the head item: 0.56 s after the resume in run
06 and 0.07 s in run 09. The terminal, started as `codex resume <thread-id> --remote`, resumes the
thread as well, so on a daemon restart a queued message can start before the bridge connects and
reads the stored turns. A bridge built on the queue would therefore meet turns that carry message
ids it never saw start, and would settle them from the stored turns after the fact.

## Duplicates and lost items

The queue does not deduplicate on `clientUserMessageId`. Run 01 added one message id twice and got
two items, and run 03 (0.148.0) ran both as separate turns. A retried add therefore runs twice, as a
retried `turn/start` does, so recovery still reads the stored turns whichever path delivers.

An item leaves the queue once its turn starts, whatever the turn's outcome. In run 03 the account
refused the model of the thread, all four turns failed within 3 s of starting, and the queue emptied
anyway; the next item started after each failure. A message in a failed turn becomes unanswered in
atc, so the queue loses nothing atc would have kept, but it keeps no record of the failure either.

The server deletes an item only after its turn has started, so a crash between the two starts the
same item again on the next load. The runs did not reproduce that window; the source shows it.

## The terminal shows nothing

In the source of 0.162.0, the stock terminal ignores `thread/queue/changed` and draws nothing for
queued items. A queued message appears at the terminal only once its turn starts, so the person at
the terminal cannot see, edit or delete what waits. The `codex queue --thread <id> --message <text>`
command adds an item through the same method.

## API stability

The methods are experimental: each one is marked `#[experimental]` in the protocol, and a client
reaches it only after `initialize` with `experimentalApi: true`. The wire shape has held:

| Releases                                    | Methods and types                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| up to 0.147.0                               | none                                                                   |
| 0.148.0 to 0.162.1, and `main` at `7c152d4` | the same six methods, `thread/queue/changed`, and the same type fields |

The behaviour behind the methods has moved more than their shape. Between 0.148.0 and 0.162.0, 11
commits touched the queue's dispatch, storage or request handling, among them the watcher for rows
another process writes, a second migration, the `queue` turn trigger, subagent ownership checks,
shutdown admission, and model-provider checks. None touched them between 0.162.0 and `main`. An
update can therefore change when a queued message starts without any change to the methods atc
calls, and the pinned-version check that the bridge needs would have to cover the queue's timing as
well.

## What the queue would replace

The queue would replace one part of atc's hold: the retry of a message whose `turn/start` failed
because the connection dropped. A bridge on the queue would still match messages to turns by
`clientId`, settle them from the turn's outcome, and recover from the stored turns after any
reconnect, because the queue neither deduplicates nor records an outcome. atc's store would gain a
second copy of every pending message, in a private SQLite file of Codex, to reconcile on each
connect.

The watcher's poll offers one more path that the runs did not test: a daemon could write rows into
`queue_1.sqlite` while no server runs. That ties atc to a private schema with no protocol behind it,
so it stays an idea.

## The runs

Each run log holds the requests, the responses and the notifications of one or more clients. The
`userAgent` in each `initialize` response holds the version of the server that answered, so every
step can be checked against the table. Paths under the scratch folder read `<scratch>`.

| Run                                        | Server versions       | Shows                                           |
| ------------------------------------------ | --------------------- | ----------------------------------------------- |
| [01](runs/01-kill-restart.txt)             | 0.162.0               | items survive SIGKILL; no deduplication         |
| [02](runs/02-across-versions.txt)          | 0.162.1, 0.148.0      | a newer and an older Codex read the queue       |
| [03](runs/03-v148-drain-failed-turns.txt)  | 0.148.0               | failed turns consume their items                |
| [04](runs/04-v148-busy-turn.txt)           | 0.148.0               | an item waits for the running turn to end       |
| [05](runs/05-v148-interrupt.txt)           | 0.148.0               | an interrupt leaves the item queued             |
| [06](runs/06-update-and-drain.txt)         | 0.162.0, then 0.162.1 | items survive the update and run after a resume |
| [07](runs/07-interrupt-and-restart.txt)    | 0.162.1               | the item stays through a kill and a resume      |
| [08](runs/08-next-turn-releases.txt)       | 0.162.1               | the next completed turn starts the item         |
| [09](runs/09-kill-mid-turn.txt)            | 0.162.1               | a kill mid-turn keeps the item, and it starts   |
| [10](runs/10-upgrade-across-migration.txt) | 0.148.0, then 0.162.1 | the item survives a queue migration             |

Runs 02 to 05 began as 0.162.x runs. A SIGKILL in run 02 ended the npm wrapper of 0.148.0 and left
its native server on the port, so the later steps of run 02 and runs 03 to 05 reached 0.148.0, as
their `userAgent` shows. They stand as 0.148.0 evidence, and runs 06 to 10 repeat their cases on
0.162.1 with the native binaries.

To repeat a run:

1. Install the Codex versions to compare into a scratch folder, such as
   `npm install --prefix <scratch>/codex-0.162.1 @openai/codex@0.162.1`, and take each native binary
   from `node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
2. Make a scratch Codex home with a copy of a signed-in `auth.json` and a `config.toml` that sets a
   `model` the account allows.
3. Start a server on that home:

   ```bash
   ./serve.sh start <native-codex-binary> 47320 <scratch-codex-home>
   ```

4. Create a thread and queue a message on it:

   ```bash
   bun step.ts ws://127.0.0.1:47320 run.log start-thread <work-folder>
   bun step.ts ws://127.0.0.1:47320 run.log add <thread-id> msg-101 "Reply with the word APPLE."
   ```

5. Stop the server with `./serve.sh stop 47320 KILL`, start another version on the same home, and
   list the queue with `bun step.ts ws://127.0.0.1:47320 run.log list <thread-id>`. Expect the item
   with `"clientUserMessageId":"msg-101"`.
6. Resume the thread with `bun step.ts ws://127.0.0.1:47320 run.log resume-watch <thread-id> 30`.
   Expect `turn/started` within a second, and a `userMessage` item with `clientId=msg-101` in
   `run.log`.

`step.ts busy-then-add <thread-id> <message-id> <text> complete|interrupt|kill` queues a message
during a turn that runs a 12 s command, and `release.ts` starts one normal turn and logs whether a
queued item follows it.
