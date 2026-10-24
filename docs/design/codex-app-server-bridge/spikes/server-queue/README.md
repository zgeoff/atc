# Spike: Codex App Server queue

This spike queues messages through the Codex App Server's experimental `thread/queue/*` methods
across kills, restarts, updates and interrupts, and reads the Codex source for the mechanism. Its
finding decides whether the Codex App Server bridge hands its messages to that queue or keeps atc's
own hold.

## Question

Can the App Server's own queue hold atc messages for a Codex session, on the terms atc delivers and
settles them?

## Answer

- A queued item survives a SIGKILL of the server and a Codex update in both directions, and the
  methods' wire shape has held since they first shipped.
- The queue starts a queued message only once the thread is idle, as a turn of its own, so the model
  never sees it during the running turn.
- After an interrupt, a queued item waits until a later turn completes, and the terminal shows
  nothing of what waits.
- The queue does not deduplicate on `clientUserMessageId`, and it drops an item once its turn
  starts, whatever the turn's outcome.
- A resume from any client, the terminal included, starts the head item, so a queued message can
  start before the bridge connects.

atc keeps its own hold for Codex sessions, and the bridge keeps `turn/start`.

## Run it

```bash
./serve.sh start <native-codex-binary> 47320 <scratch-codex-home>
bun step.ts ws://127.0.0.1:47320 run.log start-thread <work-folder>
bun step.ts ws://127.0.0.1:47320 run.log add <thread-id> msg-101 "Reply with the word APPLE."
```

The [setup](results.md#setup) gives the Codex versions, the install of each native binary, the
scratch home and the steps of a run.

## Results

The [results](results.md) hold how the queue works, each behaviour with the runs behind it, the
API's stability across releases, and a table of the runs.

## Untested

A crash between the start of an item's turn and the item's delete, and a daemon that writes queue
rows while no server runs. The [untested list](results.md#untested) gives the rest.
