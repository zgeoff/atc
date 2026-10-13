# Events

Everything the fleet does becomes an event: a session added, a state change, an attach, a note, a
message status change, a permission prompt. The daemon sends each event as one JSON line, the same
line for every consumer, and it keeps the events that a caller needs to catch up on in an event
trail in `atc.db`. Live events serve a client that is connected now; the trail serves a client that
was not.

[The protocol](./protocol.md#events) covers how events reach a client connection, and the
[events guide](../../guides/events.md) covers consuming them from a shell.

## Consumers

One broadcast reaches three kinds of consumer:

- **Client connections** receive every broadcast event within their principal's reach, and output
  and inbox events only for what they attached or tapped.
- **The events socket** streams every broadcast event to any local subscriber.
- **User hooks** run the owner's configured commands with the event's line on stdin.

A session's terminal output never reaches the events socket or a hook, because it is screen bytes
for an attached client, not fleet state.

## The event trail

The trail holds three groups of events, oldest first:

- **Hook events**, as the adapter normalized them: a start, a submitted prompt, a pending input, a
  finished turn and an end. Statusline heartbeats are stored for agent session id capture and left
  out of every read.
- **Message status changes**: queued, delivered, answered and unanswered, each with its message id.
- **Notes**, each with its label and its text up to a cap, kept once under the id the session helper
  gave it, so a resent note lands once.

The daemon writes a message or note event to the trail before it broadcasts it, so a client that
reads the trail when the broadcast arrives finds the event there. The trail is never pruned.

A caller reads the trail from a cursor, an opaque string it passes back and never builds. A read
without a cursor returns the newest events. A read can hold open until an event arrives or a wait
ends, and its answer says whether more events lie past the page, so a caller drains a backlog by
reading again at once and waits only when it is caught up. The daemon records which wake it last saw
before it queries, so an event that lands between the query and the wait still ends the wait.

A read can narrow to one session. The filter matches the rows under that atc session id and, for a
live session, the rows under its agent session id, because rows written under another atc session
for the same agent session stay part of its history. Cursors are positions in the whole trail, so a
narrowed read and a full read take each other's cursors.

Two other reads follow the same cursor rules. A session's transcript read returns a Claude Code
transcript as user and assistant rows, a page at a time, and a cursor from an earlier transcript
file, such as one from before `/clear`, restarts at the top of the current file. Grok and Codex have
no transcript reader. A note read takes a note event's cursor and returns the note's whole text.

## The events socket

The events socket streams the broadcast events with no handshake, no version negotiation and no
requests, and the daemon ignores anything a subscriber writes to it. Every line carries the protocol
version, and the envelope rule that unknown fields are ignored is the whole compatibility contract,
so a subscriber written against one atc version keeps working across upgrades that the strict client
handshake would refuse.

On connect, the daemon sends the current fleet as one added event per session, then live events
behind it, so a subscriber learns what exists without speaking the client protocol. Each subscriber
has a bounded queue, and the daemon disconnects a subscriber that overflows it. A reconnect gets a
fresh snapshot instead of the backlog it missed.

## User hooks

The config's `hooks` map runs a shell command for each event it lists, with the event's line on
stdin. Hooks are observational and fire-and-forget: the daemon never waits on one, logs a failure
and ignores it, and kills a run that outlives its timeout, so a broken hook can neither gate an
event nor slow an attach. A hook can narrow itself to sessions under one directory. The daemon
matches that filter against the session as it was when the event fired, so a filtered hook still
fires for the removal of a matching session, and an event that carries no session skips every
filtered hook.
