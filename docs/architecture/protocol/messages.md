# Messages

A message is text one caller sends a session for its agent to act on, such as one agent handing
another a task. The daemon keeps each message in the session's inbox in `atc.db` until the session
takes it, so a message survives a daemon restart and a fleet restore. The daemon never types a
message into the session's terminal: a process inside the session takes it through a tap, and the
`atc-bridge` mod inside Claude Code hands it to the model. The answer to a message is the text the
model sends with the mod's `answer` tool or, if none, the final reply of the turn that carried it,
which the mod reports when the turn ends. A turn that ends without a reply leaves the message
unanswered. When the sender is itself a session that takes messages, the daemon queues an answer
notice in the sender's inbox, so the outcome reaches the sender's conversation without a read.

[Agent integration](../agents/agent-integration.md#the-atc-bridge-mod) covers the mod, and
[events](./events.md) covers the trail that records each status change.

```mermaid
stateDiagram-v2
    [*] --> queued: message sent
    queued --> delivered: tap prints it and acks
    delivered --> answered: the carrying turn ends with a reply
    queued --> unanswered: the carrying turn ends without a reply
    delivered --> unanswered: the carrying turn ends without a reply
    delivered --> unanswered: the session's process ends
```

## Sending

A caller sends a message with its text alone. The daemon refuses the message when the session cannot
take one:

- The session's agent has no tap, as Grok and a Codex entry without an App Server have none:
  `unsupported`.
- A Claude Code session started some time ago and no tap has attached since, so the mod is missing:
  `unsupported`.
- The session has no live process: `session_dead`.

Otherwise the message queues, while the session restores and while a dropped tap reconnects too. A
busy session is no refusal: the mod adds the message to the running turn. The daemon writes messages
one at a time, in the order they arrive, and checks the sender's reach in the same step that starts
the write, so a session cannot leave a principal's reach between the check and the write.

## Who a message is from

The daemon labels each message with its sender, built from who the caller is
([principals](./principals.md#who-a-caller-is)), and stores the label with the message. No field of
the request sets the kind, so no caller can speak as another. A request's `from` names a local
program and nothing else. The daemon ignores it for every other caller, except to match an
idempotency key that an older daemon stored, because that daemon hashed the `from` with the other
params. Local `atc mcp` passes on the `from` a keyed call gives, so an unchanged retry of a send
that an older `atc mcp` made replays its message. The label holds a kind, an id and a name:

| Kind        | Caller                                                           | Id                  | Name                                         |
| ----------- | ---------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| `connector` | an OAuth client that atc-gateway or `atc mcp --http` vouches for | its OAuth client id | its client name                              |
| `session`   | a process inside an atc session                                  | the session's id    | the session's name as the message is written |
| `local`     | a program outside every session that is not an atc client        | none                | its `from`, else its handshake's client name |
| `owner`     | an atc client outside every session                              | none                | `owner`                                      |

A message also holds the sender's name as `from`, for readers that predate the kind. A message
stored before the daemon labelled senders holds that name alone. The tap line and the
`<atc-message>` envelope carry the kind, so the agent that takes a message sees who sent it
([agent integration](../agents/agent-integration.md#the-atc-bridge-mod)).

## The tap

A tap is a connection that asked for one session's inbox. The mod starts `atc tap` for its session,
and the tap prints each message as one JSON line on stdout. When a tap attaches, the daemon sends
every queued message in order, one at a time: it sends the next only after the tap acks the last,
which bounds what waits in the connection's queue. The tap prints a message, then acks it, and the
ack marks it delivered. A second tap for the same session replaces the first, which receives a
closing event and exits, so one session never has two consumers.

A Codex session on an App Server has its tap inside the daemon instead, held by the session's
[App Server bridge](../agents/agent-integration.md#codex-on-an-app-server). That bridge acks a
message once the App Server takes it into the thread.

Delivered means the tap printed the message to the mod, not that the model saw it. The mod keeps the
messages it holds for the current turn in memory, so a Claude Code process that dies after the ack
makes no report. The daemon settles those messages itself, as
[the end of a process](#the-end-of-a-process) describes.

A message belongs to the session it was sent to, and follows the agent session when the session
resumes or clears it, so a resumed session keeps its queue.

## Answers

The mod wraps each message in an `<atc-message>` envelope that holds the sender and the message id.
When the session is idle, the mod submits the message as a new turn; when a turn is running, it adds
the message to that turn. One turn can therefore carry several messages.

The final reply of a turn is meant for the person at the terminal, so the model answers each message
on its own with the mod's `answer` tool, which takes the message id and the answer text. The mod
reports that answer at once, with no turn id, and the daemon marks the message answered before the
turn ends. A message keeps its first answer, because the daemon settles only a queued or delivered
message.

When the turn ends with a reply, each message the turn carried that the `answer` tool left without
an answer takes the final reply. The mod sends one answer that holds those messages and the turn's
id, and the daemon marks them all answered in one statement, so a reader that finds one of them
answered finds the whole group answered. A turn that ends without a reply, because a person
interrupted it, it failed, or the model refused, gets one `unanswered` report for those messages
instead, with the turn's id and a one-word reason: `interrupted`, `error` or `refusal`. A message
whose prompt a hook dropped is reported `unanswered` with the reason `not_started`, because no turn
will ever carry it. A prompt queued behind a running turn keeps waiting when that turn ends without
a reply, because the session can still run the queued prompt as a turn of its own. A message the
model never saw, one added to a running turn that ended before its next step, is delivered again
instead.

Unanswered is final. A later answer for that message changes nothing, and atc never delivers the
message again, because redelivering after an interrupt would restart work a person stopped, and
redelivering after an error would repeat the failure. A caller that wants the work done sends the
message again. A read of an unanswered message returns `unansweredAt` and `unansweredReason`, and a
read that waits returns as soon as the status becomes answered or unanswered.

A caller reads a message's status, answer and turn by its id, and can hold the read open until the
status moves. Message ids and statuses live in `atc.db`, so a caller whose wait ended, or whose
connection dropped, reads again with the same id. A caller with no inbox, such as an MCP client
outside atc or a remote connector, learns the outcome this way, or from the event trail, which keeps
each whole answer on the message's answered event ([events](./events.md#the-event-trail)). A sending
session gets it pushed as well, as [delivering answers](#delivering-answers) describes.

### The end of a process

When a session's process exits, or a person kills or removes the session, the daemon marks each
message the session holds delivered `unanswered` with the reason `session_ended`. The mod's state
died with the process, so no report about those messages can arrive. The daemon marks them rather
than delivering them again when the session revives, because nothing promises a revive, and the
ended turn may have done part of the work that a second delivery would repeat. A message still
queued stays queued for the session's next process.

Every local process ends with the daemon that started it, so a daemon that starts marks the
delivered messages of every fleet session on its own machine the same way. A session whose agent
session id a live fleet row on a remote target holds marks only the messages sent to it, because
that row's session may still run there and hold its own. Three ends mark nothing, because the
process may still run:

- A host that goes to sleep with the process inside, which a wake resumes.
- A connection to a remote host that is lost for good, since a revive can attach to the same
  process.
- The end of a session while another live session resumes the same agent session, since the daemon
  cannot tell which of the two processes holds a message.

## Delivering answers

A session that sends a message gets its outcome pushed into its own conversation, because a session
that forgets to read the message would otherwise wait on an answer atc holds. The daemon records the
sender session with each message. It takes that session from the caller's connection, whose
handshake holds the session the caller runs inside, and never from the sender name, which a local
caller can set to anything. The daemon records a sender session only when that session takes
messages and, for a caller that acts as a principal, when the session's tree is within the
principal's reach. Every other caller gets no notice, and `atc mcp --http` claims no session, so a
remote connector's message never reaches the session that started the server. A send that gives
`notice: false` records no sender session, because a message that needs no answer, such as a tool's
notice of a finished job, would otherwise push its answer into the session that ran the tool.

When a message becomes answered or unanswered, whichever path settled it, the daemon queues one
answer notice for its sender session in `atc.db`, in the same statement that settles the message, so
a daemon that stops right after it settles a message holds the notice when it starts again. The
daemon queues each message's notice once, so a repeated answer report or a replayed tap queues no
second notice. The notice waits in the sender's inbox the way a queued message waits, while the
sender is asleep, exited or restoring, and the sender's next tap takes it.

A tap takes notices only when it asks for them as it opens, because a tap from before notices would
read one as a message and answer it. The daemon sends a tap its queued messages first and then its
notices, one at a time, each as an `InboxNotice` event that holds the message id, the session the
message went to, the status, and the answer or the unanswered reason. The tap prints a notice as a
JSON line of kind `answer` with no text field, then acks it with `notice.ack`, and the ack marks the
notice delivered. The event trail records `notice-queued` and `notice-delivered` under the sender
session, with the message id. A daemon that stops before it records `notice-queued` leaves no such
entry, and the notice reaches the sender all the same.

The mod hands a notice to the model in an `<atc-answer>` envelope that holds the message id, the
answering session, the status and, for an unanswered message, the reason. The answer is the body,
escaped the way a message envelope escapes its text. An idle sender takes the notice as a new turn,
and a busy one takes it inside the running turn. A notice is never a message: the mod never counts
it among a turn's messages, so the turn that reads it reports no answer, and two sessions cannot
send answers back and forth. A notice the model never saw, one added to a running turn that ended
before its next step, is delivered again, as an unseen message is.

## Progress notes

A note is progress a session sends with no message attached, through the mod's `note` tool, labelled
`progress`, `blocked` or `decision`. The daemon records each note in the event trail and broadcasts
it. A note never answers a message: the `answer` tool or the turn's final reply does.

## Remote sessions

A session on an imp has no reporter socket and no client socket, so its tap, notes, answers and
answer notices travel over its [session bridge](../execution/imp-provider.md#the-session-bridge).
There the tap reconnects after every dropped connection, with no end, since a sleep or a daemon
restart drops it. Each new connection replays the messages and notices not yet acked, and the tap
prints each one once and acks a repeat again. A note or an answer waits in an outbox file beside the
bridge socket until the bridge takes it, and the tap sends the outbox again on every connection, so
a note survives a dropped connection and lands once.

A local session has no outbox. Its notes and answers go to the reporter socket once, and a daemon
that is down at that moment loses them. Its tap exits when the daemon goes away, which ends the
local session too, and the restored session starts a tap of its own.
