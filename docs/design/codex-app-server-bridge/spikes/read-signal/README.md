# Spike: Codex read signal

This spike drives a Codex App Server thread through steers, interrupts and restarts, and records
which wire event shows that the model read a delivered message. Its finding sets the read mark the
Codex App Server bridge uses when a turn ends interrupted or failed.

## Question

Can the bridge tell that the model read a delivered message, and not only that the App Server took
it, with a mark that holds across a restart? atc delivers a message again when the model never saw
it, and leaves it unanswered when the model did.

## Answer

- `rawResponse/completed` marks a read correctly while the thread stays loaded, but only on a thread
  started with the internal-only `experimentalRawEvents` flag, which the thread loses whenever it
  reloads.
- The first `agentMessage` or `reasoning` item that starts after a message's `userMessage` item, in
  the same turn, gave the right verdict in all 5 steer runs and both interrupt runs, with no flag.
- That rule can mark a read message unread, as in a command poll that took 8 s to produce a model
  item, so the error repeats a message and never drops one.
- The stored turns drop a reply that Codex cut short, so they cannot replace a mark the bridge saw
  live.
- `thread/tokenUsage/updated` and the `userMessage` item alone both mark an unread message read.

Mark a message read at its first model item after its `userMessage` item, and keep that mark in the
daemon store.

## Run it

```bash
CODEX_HOME=<scratch-codex-home> codex app-server --listen ws://127.0.0.1:47291
bun probe.ts ws://127.0.0.1:47291 steer-stream <log-file> "" 1
bun summarize.ts <log-file>
```

The [setup](results.md#setup) gives the Codex version, the scratch home's config, the probe's
arguments and its scenarios.

## Results

The [results](results.md) hold each finding with the runs behind it, the full recommendation for the
bridge, and a table of the runs.

## Untested

The order of `reasoning` items against a steered message, and a failed turn or a compaction after
the `userMessage` item. The [untested list](results.md#untested) gives the rest.
