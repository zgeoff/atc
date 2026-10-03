# Wire protocol

The daemon/client protocol: newline-delimited JSON (NDJSON) over a unix socket, one JSON object per
line, UTF-8. No binary frame class. This was decided against a hybrid JSON-control / binary-data
design on measured evidence:

- `bun-pty` delivers PTY output as decoded JS strings (streaming TextDecoder inside the library), so
  byte-level transparency is already gone before the protocol sees the data — binary framing would
  buy size, not fidelity.
- JSON string escaping of an ANSI-heavy full-screen repaint measures ~1.27x expansion (1.02x on
  plain text), and encode+parse costs ~0.1–0.2% of one core at a 1 MB/s worst case. The tmux
  control-mode ~4x tax comes from octal-escaping every control byte, which JSON does not do.
- One parser, one id space, one socket dialect: the hook and statusline reporters already speak
  NDJSON to the daemon socket, SDK agent sessions emit JSON natively, and the MCP tools are a
  field-rename away from the control envelope.

Revisit trigger: if the PTY layer is ever replaced with a byte-level provider, transparency returns
and a base64 or binary data path earns reconsideration. Until then it is a cost with no benefit.

## Envelope

Three message kinds, distinguished by which fields are present. Every line carries `v` (protocol
version) so a socket tap can interpret lines standalone.

```jsonc
// request  (client -> daemon); id is client-assigned, monotonic per connection
{ "v": 4, "id": 7, "m": "session.spawn", "p": { "cwd": "/x", "name": "auth-bug" } }

// a request that acts as a principal
{ "v": 4, "id": 8, "m": "session.list", "as": "hV3kQ9xLm2Rt7YpZ4cWn8bJd6fGs1aEu" }

// response (daemon -> client); exactly one per request
{ "v": 4, "id": 7, "ok": { "session": "s7-m4x2p" } }
{ "v": 4, "id": 7, "err": { "code": "no_such_session", "msg": "…" } }

// event    (daemon -> client, unsolicited, never acknowledged)
{ "v": 4, "ev": "SessionOutput", "s": "s7-m4x2p", "seq": 41, "d": "[1mhello[0m" }
```

Methods are `noun.verb`; events are PascalCase, the naming style hook consumers already know from
Claude Code's hook events. The MCP tools map onto both mechanically (`session.spawn` → tool
`atc_session_spawn`, `SessionAdded` → a notification). Error codes are human-readable strings from a
closed, extendable set: `protocol_mismatch`, `unauthorized`, `unknown_method`, `bad_args`,
`no_such_session`, `session_dead`, `unsupported`, `unsupported_operation`, `unknown_target`,
`target_unavailable`, `target_changed`, `target_config_invalid`, `target_forbidden`,
`host_unavailable`, `auth_not_configured`, `host_leased`, `confirmation_required`,
`confirm_token_invalid`, `already_answered`, `too_slow`, `stale_epoch`, `idempotency_conflict`,
`outcome_unknown`, `github_unavailable`, `internal`, plus the workspace refusals that
[workspaces](#workspaces) lists. An unknown method is an `unknown_method` error, never a disconnect;
unknown fields in any message are ignored. A peer decodes an error code it does not know as
`internal` and keeps its `msg`. These rules exist so additive evolution never breaks a peer. An
error may also carry `data`, an object whose fields its code defines.

`unsupported_operation` refuses a request that the session's execution host cannot serve, such as
input to a host that takes none. Its `data` holds the provider kind as `provider` and the missing
capability as `capability`. The [daemon architecture](./daemon.md#execution-providers) covers
providers and their capabilities.

## Handshake

The first line on a connection must be `daemon.hello`; the daemon answers nothing else before it.
Versioning is a single integer with strict equality — daemon and client ship from the same repo, so
the only mismatch that happens in practice is a long-running daemon outliving an upgrade. The
failure must be actionable, not cryptic: the error names both versions and both build strings and
says to restart the daemon. The client never restarts the daemon on its own; the
[daemon architecture](./daemon.md#one-daemon-per-state-directory) covers the deliberate restart.

```jsonc
{ "v": 4, "id": 1, "m": "daemon.hello",
  "p": { "client": "atc/0.4.0", "auth": { "scheme": "none" } } }

{ "v": 4, "id": 1, "ok": { "daemon": "atc/0.4.0",
                           "daemonID": "0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30",
                           "limits": { "maxLine": 1048576, "maxChunk": 65536 },
                           "features": ["agents.list", "events.more", "events.session",
                                        "message.turn", "message.wait", "spawn.options",
                                        "daemon.id", "session.locator", "spawn.idempotency",
                                        "message.idempotency", "spawn.target",
                                        "request.principal", "spawn.workspace", "session.forget",
                                        "session.submit", "report.get", "sources",
                                        "git.probe"],
                           "lastUsedAgent": "claude" } }
```

`features` lists the request features the daemon serves beyond the protocol version: `agents.list`
exists, `events.read` returns `more` and takes `session`, and `message.get` returns `turn` and
`answeredWith` and takes `waitMs`, `session.spawn` takes `model` and `effort` while `agents.list`
returns `spawnOptions`, `daemon.hello` returns `daemonID`, every session descriptor holds a
`locator`, `session.spawn` and `session.message` each take `idempotencyKey`, `session.spawn` takes
`target` while `agents.list` returns `targets`, a request takes `as` while `daemon.hello` takes
`principal`, `session.spawn` takes `workspace`, `session.forget`, `session.submit`, and `report.get`
exist, `sources.list` and `sources.interpret` exist while `agents.list` returns `sources`, and
`git.probe` exists while a git `workspace` takes both `ref` and `sha`. A daemon from before the list
existed sends none, and it ignores the parameters it does not know. A client that outlives a daemon
upgrade, such as `atc mcp`, reads the list rather than the build string to learn what the running
daemon honours.

`daemonID` is the id the daemon minted into its state store the first time it opened it, so it stays
the same across daemon restarts. Every session descriptor holds a `locator` of
`{ daemonID, targetID }`: the daemon that hosts the session, and the [execution target](#targets) it
runs on. A session spawned with a [workspace](#workspaces) holds a `workspace` with what its working
directory was materialized from.

`lastUsedAgent` is the agent id of the last deliberate spawn that reported SessionStart. The
built-in ids are `claude`, `grok`, and `codex`. A spawn that never reports SessionStart does not
change it. A fleet restore SessionStart does not change it. MCP spawn ignores the value and defaults
to Claude.

`auth` is present from day one (`{"scheme": "none"}` on the unix socket) so a TCP or SSH transport
later adds a scheme, not a handshake redesign. The transport is assumed to be an ordered, reliable
byte stream and nothing more — no unix-socket peer credentials or filesystem paths in message
semantics.

## Methods

| Method                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon.hello`          | handshake; must be first. The ok includes `lastUsedAgent`, the agent id written on a deliberate-spawn SessionStart.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `daemon.ping`           | liveness / latency probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `daemon.quit`           | stop the daemon; every hosted session goes down with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.list`          | fleet listing (descriptors mirror the `Session` shape, minus the PTY handle, plus `kind` and `agent`)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `dirs.list`             | recent spawn directories, most recent first, for the picker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `agents.list`           | the registered agents and the host the daemon runs on. [Agents](#agents) covers the answer                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fleet.list`            | the persisted fleet rows, independent of which sessions are currently live. Each row holds its `sessionID`, the `agentSessionID` once the agent reports one, and `parent` as an atc session id.                                                                                                                                                                                                                                                                                                                                                |
| `sources.list`          | one source's candidates for the spawn picker (`{ source, target?, scope?, text? }`). [Sources](#sources) covers the answer                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sources.interpret`     | what one source reads typed input as (`{ source, input, target? }`). [Sources](#sources) covers the answer                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `git.probe`             | check that the daemon's host can read a git workspace source and resolve its ref (`{ url, ref?, sha?, credentialRef?, target? }`). [Sources](#sources) covers the answer                                                                                                                                                                                                                                                                                                                                                                       |
| `session.spawn`         | spawn (cwd, name, prompt, resume, dims, optional `agent` id, optional `parent` id, optional `model` and `effort`, optional `idempotencyKey`, optional `target`, optional `workspace`). Omitted agent is Claude, an empty id is `bad_args`, an unregistered one `unsupported`. An unknown parent is `no_such_session`. [Spawn options](#spawn-options) covers `model` and `effort`, [idempotent requests](#idempotent-requests) covers `idempotencyKey`, [targets](#targets) covers `target`, and [workspaces](#workspaces) covers `workspace`. |
| `session.update`        | rename and/or pin a session (`{ session, name?, pinned? }`). Pinning a sub-session is `bad_args`: it pins with its parent.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `session.kill`          | end a session or put its host to sleep; explicit, never implied by disconnect. [Kill and sleep](#kill-and-sleep) covers the cases                                                                                                                                                                                                                                                                                                                                                                                                              |
| `session.ack`           | clear unread without attaching                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.forget`        | forget a session for good, destroying its host on a target that can. [Kill and sleep](#kill-and-sleep) covers the confirm token                                                                                                                                                                                                                                                                                                                                                                                                                |
| `session.attach`        | subscribe to a session's output; returns replay + current dims                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.detach`        | unsubscribe; session keeps running                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.input`         | keyboard input to a session (`{ session, d }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.submit`        | type a line into a session and submit it (`{ session, text }`). [Submitting a line](#submitting-a-line) covers how                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.resize`        | client reports its dims; effective size is the min across attached clients (broadcast as `SessionResized`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `session.resumeCommand` | build the resume command for that session's agent (`claude --resume`, `grok --resume`, or `codex resume`)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `session.screen`        | the session's visible screen as plain text (`{ text, cols, rows }`), no attach needed; a killed session keeps its last screen                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session.eject`         | hand a live session off to a headless run so it keeps working unattended                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session.adopt`         | bring a dead or headless session back onto a live terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fleet.restore`         | cold-boot recovery: respawn the persisted fleet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `permission.respond`    | answer a permission request (`{ request, decision }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session.get`           | one session's descriptor plus its spawn prompt, last activity, pending prompt, and latest result (`{ session }`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `session.read`          | a Claude session's transcript, a page at a time from a cursor (`{ session, cursor?, limit? }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `events.read`           | fleet events from the hook-event trail since a cursor (`{ cursor?, limit?, waitMs?, session? }`)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `report.get`            | one report with its whole text, by the cursor of its event (`{ report }`). [Cursor reads](#cursor-reads) covers it                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.message`       | queue a message for a session (`{ session, from, text, idempotencyKey? }`); the ok holds the message id. [Messages](#messages) covers refusals, and [idempotent requests](#idempotent-requests) covers `idempotencyKey`                                                                                                                                                                                                                                                                                                                        |
| `session.tap`           | subscribe to a session's inbox; messages arrive as `InboxMessage` events                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `message.ack`           | mark a tapped message delivered (`{ session, message }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `message.get`           | one message with its status, answer, turn, and timestamps (`{ message, waitMs? }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`session.input` is a request (it gets an ok, preserving the rule that state-changing messages are
acknowledged) but clients need not await it — measured cost of the JSON round trip is ~0.2 µs
against a ~3 µs socket round trip. Ordering between input, resize, and output is guaranteed by
construction: one socket, one ordered stream.

Multi-client rules, chosen to cover the realistic conflicts without a write-lock protocol:

- Input atomicity: a client sends one complete key event or one complete paste per `session.input`;
  the daemon writes each input payload to the PTY whole, never interleaving bytes from two clients
  inside one payload. Client input is decoded statefully per client so a multi-byte character split
  across reads is never mangled.
- Line atomicity: the writes that type and submit one `session.submit` line go to the PTY together,
  so no other client's input lands between the text and its submit key.
- Resize debounce: the daemon debounces effective-dimension changes (~50 ms) and suppresses PTY
  resizes when the effective size is unchanged, so two clients resizing in opposite directions
  cannot produce a SIGWINCH storm.

## Submitting a line

`session.input` writes its bytes to the PTY exactly as sent. `session.submit` types `text` as one
line and submits it the way the session's agent accepts a line, which the agent's adapter decides:

- Claude, and a gateway that runs the Claude CLI, get the text and a newline in one write: the same
  bytes as a `session.input` of the text and a newline.
- Codex and Grok keep a newline that arrives inside a burst of input as part of the text, so a line
  typed with its newline stays unsent in the composer. They get the text between bracketed paste
  markers (`ESC[200~` and `ESC[201~`), then a carriage return as a second write. The markers make
  the text one paste event, so the carriage return reads as Enter however the two writes arrive.
  Paste markers inside the text are dropped, so the text cannot end its own paste. The daemon reads
  from the session's screen model whether the TUI has turned bracketed paste on (DEC mode 2004);
  until it has, the text goes unmarked. In that case the text and the carriage return go out in the
  same tick and can arrive as one burst, so the daemon cannot promise that the line is submitted.
  The daemon reads the mode from the output parsed so far and does not wait for output still queued,
  so a line sent just as the TUI turns bracketed paste on can go out unmarked too.

A headless session takes the line as the prompt of its next turn, as it takes `session.input`. The
ok means the daemon wrote the line and its submit key to the PTY, not that the agent answered.

## Events

`SessionAdded`, `SessionState`, `SessionAttached`, `SessionDetached`, `SessionRenamed`,
`SessionRemoved`, `SessionResized`, `SessionOutput`, `SessionDesync`, `SessionMessage`,
`InboxMessage`, `InboxClosed`, `SessionReport`, `PermissionRequested`, `PermissionResolved`.

State/lifecycle events broadcast to every client (every overlay needs them). `SessionOutput` goes
only to clients attached to that session — an unfocused session costs a client zero bytes. Output
events carry a per-session `seq` so a client can detect gaps.

`SessionAttached` broadcasts each time a client subscribes to a session's output, and
`SessionDetached` each time one subscription ends — by request or by the subscriber's connection
closing. `SessionAttached` is the dedicated focus signal for outside observers; attaching also
clears the session's unread flag, so a `SessionState` broadcast arrives alongside it. A detach of a
session that no longer exists emits nothing — `SessionRemoved` already covered it.

`SessionAdded`, `SessionState`, `SessionAttached`, and `SessionDetached` carry the full session
descriptor under a `session` key (the same shape `session.list` returns), rather than a hand-picked
subset of fields — a client decodes them through one path instead of tracking which fields each
event happens to carry.

Every descriptor holds a `lifecycle` object of four layers, and `state` derives from them and the
session's attention:

| Layer        | Values                                         | Holds                                       |
| ------------ | ---------------------------------------------- | ------------------------------------------- |
| `desired`    | `run`, `sleep`, `stop`                         | what the operator last asked of the session |
| `vm`         | `none`, `awake`, `asleep`, `unknown`           | the last state the daemon saw of the host   |
| `harness`    | `running`, `suspended`, `exited`               | the agent process                           |
| `attachment` | `local`, `attached`, `reattaching`, `detached` | the daemon's connection to the output       |

`vm` is `none` and `attachment` is `local` for a session on the daemon's own machine. `suspended` is
a process kept inside a sleeping host, which a revive brings back as it was. `reattaching` is a
remote harness whose connection dropped while the daemon restores it, and a `SessionState` event
carries each change between it and `attached`. A session whose harness is not `running` lists with
`state` `exited`; a running harness lists with the attention its hooks last reported.

A sub-session's descriptor carries the id of its parent under `parent`; a top-level session's
descriptor omits the key. A spawn whose `parent` is itself a sub-session lands beside it, under the
same parent, so a set stays one level deep.

```jsonc
{
  "v": 3,
  "ev": "SessionState",
  "session": {
    "id": "s7-m4x2p",
    "name": "auth-bug",
    "cwd": "/x",
    "state": "needs_you",
    "unread": true,
    "lastMsg": "needs input",
    "agent": "claude",
    "pinned": false,
    "lastAttachedAt": 1732000000000,
    "repoRoot": "/x",
    "namedBy": "auto",
    "createdAt": 1732000000000,
    "kind": "pty",
    "alive": true,
    "canEject": true,
    "lifecycle": { "desired": "run", "vm": "none", "harness": "running", "attachment": "local" },
  },
}
```

## Cursor reads

`session.get`, `session.read`, and `events.read` let a client catch up from a cursor it holds,
without attaching or reading the screen. A cursor is an opaque string: a client passes back the one
it received and never builds one. `limit` defaults to 50 and clamps to 1–200.

`events.read` serves the event trail in `atc.db`, oldest first. Each event holds its cursor, time,
session id and name, kind, and a short detail. The trail holds three groups of kinds:

- Hook events: `started`, `prompt-submitted`, `needs-input`, `turn-done`, and `ended`.
- Message status changes: `message-accepted`, `message-delivered`, and `message-answered`. A
  `message` field holds the message id, which `message.get` takes. The detail previews the answer
  once there is one, else the text.
- Reports: `report`. A `label` field holds the report's label, and the detail holds the first 600
  characters of its text. `report.get` returns the whole text.

Without a cursor, `events.read` returns the most recent `limit` events. `waitMs` holds the request
open until an event arrives or the wait ends, for at most 30 seconds. The answer holds `more`, which
is true when events past the page's last one exist; a read without a cursor returns the newest
events, so its `more` is always false. The daemon writes a message or report event to the trail
before it broadcasts the matching `SessionMessage` or `SessionReport`, so a client that reads the
trail on the broadcast finds the event there.

`session` limits `events.read` to one session's events. The filter matches the trail rows under that
atc id, plus, for a live session, the rows under its agent session id, so rows written under another
atc id for the same agent session stay in the session's slice. The daemon refuses no id: an id no
live session holds matches only the rows under it. Cursors are global trail positions, so a filtered
read and an unfiltered read take each other's cursors.

`report.get` takes the cursor of a report's event as `report` and returns one report: `report` (that
cursor), `at`, `session`, `name`, `label`, `text`, and `complete`. The text is the whole text the
session sent, cut at 64 KiB. A report recorded before the daemon kept whole texts holds only its
preview, so `report.get` returns that preview as its text, with `complete` false. A cursor of an
event that is not a report, or of no event at all, gets `bad_args` with `no report '<cursor>'`, the
same refusal a report out of a principal's reach gets.

`session.read` returns a Claude session's transcript as user and assistant rows with tool uses
summarised, oldest first. A page holds at most `limit` rows and about 256 KiB. Without a cursor, it
starts at the beginning of the transcript. A cursor from a different transcript file, such as one
from before `/clear`, restarts at the top of the current file. `session.read` refuses Grok and Codex
sessions with `unsupported`.

`session.get` returns the session descriptor plus the prompt the session was spawned with, its last
activity time (the time of its latest trail event of any kind), the prompt or question it waits on
while it needs you, and the final message of its latest turn, cut at 16 KiB. The fleet row holds the
spawn prompt and latest result, so both survive a restore.

## Agents

`agents.list` returns a `daemon` object with the host's name, platform, and architecture and the
daemon build, plus one entry per registered agent id. An entry holds the id, label, kind,
`installed`, `capabilities`, and `models`:

- `kind` is the agent CLI family, which the agent's adapter declares. It is an open string, so a
  client must accept a kind it has not seen. An adapter without a profile is listed with its id as
  its label and kind.
- `installed` is true when the agent's binary resolves on the daemon's `PATH` or at its configured
  path. A registered agent whose binary is missing stays in the list with `installed` false.
- `capabilities` holds one boolean each for `spawn`, `readTranscript`, `message`, `attach`,
  `screen`, and `input`. `spawn` is true only for an installed agent, `message` follows the agent's
  message tap, and every agent takes `attach`, `screen`, and `input`, since each session runs in a
  PTY.
- `models` holds the model names the config sets explicitly, keyed by role, and is null otherwise.
  For a gateway, `ANTHROPIC_MODEL` is the `default` role and each `ANTHROPIC_DEFAULT_<TIER>_MODEL`
  is the tier in lower case.
- `spawnOptions` holds a `model` and an `effort` entry, which [spawn options](#spawn-options)
  covers.

The answer never holds an environment value, a credential, an `apiKeyHelper` command, or a base URL,
and no field describes which plans an agent's account holds.

The answer also holds the execution targets:

- `targets` holds one entry per well-formed target, in config order: its `id`, its `provider` kind,
  `identity`, `available`, `default`, and `capabilities`. `available` is false when this daemon has
  no provider of that kind, and such a target's capabilities are all false. An entry never holds the
  target's options, which can hold a host's address or an account.
- `spawnDefaults` holds the `agent` and `target` a spawn without either runs with. `target` is null
  when the config gives no default, and such a spawn fails with `target_config_invalid`.
- `configRevision` is a 16-digit hex digest of each target's id and identity, the default target,
  and the target errors. It is the same for the daemon's whole life, and it changes whenever the
  target config does.
- `targetErrors` holds each config problem that leaves a target, or every target, unusable: its
  `scope` (`config`, `targets`, `target`, or `defaultTarget`), the `target` id for an entry's
  problem, and the `problem`. A `config` problem is a config file that exists but cannot be used:
  its `problem` is `config_malformed` or `config_unreadable`, with the file's `path` and a `detail`,
  and it leaves no target usable, `local` included.

### Spawn options

`session.spawn` takes an optional `model` and `effort` for the new session, and the daemon checks
both against the `spawnOptions` entry `agents.list` returns for the agent, so a spawn accepts
exactly what the list advertises. Each entry holds these fields:

| Field           | Holds                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| `supported`     | whether atc passes the option to the agent's CLI                                        |
| `available`     | whether a spawn on this host can pass it now: supported and the agent installed         |
| `values`        | the closed set a value comes from, or null for any alias or model name                  |
| `examples`      | values worth offering, each with `resolvesTo`, the provider model the config maps it to |
| `default`       | the value the configured arguments pass, or null when the CLI picks its own             |
| `backendEffect` | `applied`, or `unverified` when the backend behind the CLI may ignore the value         |
| `note`          | one line on how atc passes the value, or why it does not                                |

A gateway whose `args` set no `--model` takes `ANTHROPIC_MODEL` from its `env` as the model
`default`.

Support follows each CLI's own flags:

| Agent     | `model`                                                                           | `effort`                                              |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `claude`  | `--model`; examples are Claude Code's documented aliases                          | `--effort`: `low`, `medium`, `high`, `xhigh`, `max`   |
| a gateway | `--model`; examples are the tiers the gateway's `env` maps, with the mapped model | `--effort`, same levels, `backendEffect` `unverified` |
| `codex`   | `-m`                                                                              | not supported                                         |
| `grok`    | not supported                                                                     | not supported                                         |

Codex documents its reasoning effort levels as advertised by the selected model, with no closed
list, so atc passes Codex no effort.

The daemon refuses a spawn before it starts any process:

- An agent whose binary does not resolve is `unsupported`, with or without options.
- An option whose `available` is false is `unsupported`. atc never drops an option silently.
- A model longer than 200 characters, empty, starting with `-`, or holding a control character is
  `bad_args`. Any other alias or full model name passes as given.
- An effort outside the option's `values` is `bad_args`.

Each value reaches the CLI as its own argument, never through a shell. An override replaces any
`--model` or `--effort` in `claudeArgs` or a gateway's `args`, value included, for that spawn alone.
A spawn that sets neither runs with the configured arguments as they stand.

The fleet row stores the session's `model` and `effort`. A fleet restore, an adopt, and a headless
turn all reuse the stored values. A `session.spawn` that resumes an agent session id with its own
`model` or `effort` runs with those, and the row stores them for the new process. A row with no
stored value passes neither flag, so a session spawned without them keeps behaving as it did.

## Targets

`session.spawn` takes an optional `target`, the id of the execution target the session runs on. A
spawn without one runs on the default target, which `agents.list` returns as `spawnDefaults.target`.
A sub-session runs on the default target too, unless its spawn holds one; it never inherits its
parent's. The [configuration guide](../guides/configuration.md#targets) covers how targets are set.

A session binds to its target's identity when it spawns: the provider kind, a colon, and the first
16 hex digits of a sha256 over the target's options with sorted keys, such as
`local-pty:44136fa355b3678a`. The fleet row holds the target and the identity. A row without either
binds to `local` with the identity of the implicit `local` target.

Every request that starts work on a session checks the session's target first, in one place: a
spawn, an adopt or fleet restore, terminal input, an attach, a kill, an eject, and a headless turn.
The daemon never runs a session anywhere but the target it is bound to, and a check that fails
refuses the request before anything starts:

- A config file that exists but cannot be read or parsed is `target_config_invalid` for every
  target, `local` included, with `data.problem` (`config_malformed` or `config_unreadable`),
  `data.path`, and `data.detail`.
- A target whose config is malformed is `target_config_invalid`, with `data.target` and
  `data.problem`. A spawn without a target when the config gives no default is the same code with
  `data.problem` alone.
- A target the config does not hold is `unknown_target`, with the id as `data.target`.
- A target whose identity is not the session's is `target_changed`, with `data.target`,
  `data.boundIdentity`, and `data.currentIdentity`.
- A target whose provider kind this daemon does not have is `target_unavailable`, with `data.target`
  and `data.provider`.
- A provider without the capability the request needs is `unsupported_operation`. A headless turn
  needs `headless`.
- A remote host that cannot be created, woken, or reached is `host_unavailable`, with the provider
  kind as `data.provider` and the host's own error code, lowercased, as `data.problem`. A restore
  lists such a session as exited.
- An agent that cannot run on a remote host is `unsupported_operation`, with the agent id as
  `data.agent` and `no_guest_atc` as `data.problem` when its hooks need an atc inside the host and
  the host has none, or `remote_unsupported` when the agent never runs remotely, such as a gateway
  whose credential helper runs on the daemon's machine.
- An agent whose sign-in check fails inside a remote host is `auth_not_configured`, with
  `data.agent` and `data.target`. No harness starts.

A refused spawn under an idempotency key leaves the key free for a retry. A restore lists a session
whose target the daemon cannot use as exited, and input or `session.adopt` on it answers with the
target refusal. A dead session takes no input on a target that works: `session_dead`.

## Principals

A request acts as a principal when its envelope holds `as`, a non-empty string, and a connection
acts as one when its `daemon.hello` params hold `principal`. A request with neither acts as the
daemon's owner. A request's principal can only narrow its connection's: on a connection that acts as
a principal, a request that acts as another reaches only the targets both may use. A daemon without
the `request.principal` feature ignores both fields, so a client that acts for a principal sends
nothing to such a daemon. An `as` that is not a non-empty string is a malformed line, and the daemon
refuses a handshake whose `principal` is not one with `bad_args`.

The [configuration guide](../guides/configuration.md#principals) sets which targets each principal
may use. Each target grant matches a target name and its identity now. A session is within the
principal's reach when the target and bound identity of every session in its tree match a grant: its
top-level session and each sub-session of that one. To a principal, a session out of reach does not
exist:

- `session.list`, `fleet.list`, and `events.read` leave it out, and the daemon reads `events.read`
  filtered to it as a filter on a session the trail never held.
- `report.get` refuses each of its reports as it refuses a cursor of no report.
- The daemon refuses every request that takes its session id, or the id of one of its messages, as
  it refuses one for an unknown id, with the same code, message, and `data`.
- `agents.list` lists only the targets the principal may use, and `spawnDefaults.target` is null
  when the principal may not use the default.
- A spawn whose `parent` is out of reach is refused as a spawn under an unknown parent.
- A session whose tree leaves the principal's reach, such as a parent that gains a sub-session on a
  target the principal may not use, leaves a principal connection's view: the connection is pushed
  `SessionRemoved` for it, as for a forgotten session, and loses its output and its inbox tap. A
  session whose tree comes back within reach is pushed as `SessionAdded`.
- A request checks the reach again after each of its waits, before it answers or acts. A session
  whose tree leaves reach during `fleet.list`, `events.read`, `message.get`, `message.ack`,
  `report.get`, `session.get`, `session.screen`, `session.read`, `session.adopt`, or
  `session.message` answers as a session the daemon never held, and its message or report as an
  unknown one. A spawn whose `parent` leaves reach before its harness starts is refused as a spawn
  under an unknown parent. A spawn whose new session leaves reach before the answer goes out fails
  with `target_forbidden`, as the replay of its key would.
- Events and messages belong to the session they were recorded under. A session within reach that
  resumes the same agent session as one out of reach never shows the other's events, messages, or
  activity time. A principal's inbox tap receives only the messages sent to that session's own id,
  and its `message.ack` answers a message sent to another session as an unknown message. A
  `message.get` lists in `answeredWith` only the messages sent to sessions within reach, and an
  event or a report is checked against the session it was recorded under, never another session that
  resumes the same agent session.
- `dirs.list` lists only the directories of spawns on targets the principal may use. A directory
  recorded before atc recorded each spawn's target counts as a spawn on a `local` target with no
  options.
- A connection that acts as a principal is pushed only the events of sessions within reach, and a
  permission request's resolution only when it was pushed the request.

A spawn to a target the principal may not use, named or the default, fails with `target_forbidden`,
with the target as `data.target`. So does the replay of a held spawn key when the principal no
longer reaches the target, at the identity, that the key recorded for its session, even after the
session is forgotten; the refusal holds no part of the session. The replay gets the same refusal
when the session's tree is out of reach: the live tree while the daemon holds the session, and the
tree its fleet rows hold once it no longer does, such as after a restart. A key that records no
target, which only a key from before atc recorded them holds, refuses every principal's replay; the
daemon's owner still gets the session. A kill, a forget, or a pin checks the tree in the same step
that starts it, and a kill or a forget acts only on the sub-sessions the tree held then.
`daemon.quit` and `fleet.restore` act on the whole daemon, and a principal gets `unauthorized` for
them. The [events socket](#events-socket) has no handshake and streams every event: it is a local
socket for the daemon's owner alone.

## Workspaces

`session.spawn` takes an optional `workspace`, the source of the session's working directory.
Without one, the session runs in `cwd` as it stands. With one, the daemon materializes a clean
checkout of a pushed commit into `cwd` on the session's target, and the session starts there once
the checkout is verified:

```jsonc
{ "kind": "path", "path": "/home/me/src/app", "allowDirty": "warn" }

{ "kind": "git", "url": "https://github.com/me/app.git", "ref": "main",
  "credentialRef": { "kind": "env", "name": "APP_GIT_TOKEN" } }
```

- A `path` source is a git checkout on the daemon's host. It resolves to origin's URL, stripped of
  any credential, and to HEAD, which origin must already hold. Uncommitted or untracked changes
  refuse the spawn as `workspace_dirty`. With `allowDirty: "warn"`, the checkout is HEAD, the
  changes stay behind, and the spawn answer holds `warnings`.
- A `git` source is a repository URL with `ref`, a branch or tag, `sha`, a full commit id, or both.
  With both, the daemon checks out `sha`, on the branch `ref` names when the upstream has that
  branch, and records `ref` as the ref it was resolved from without checking that `ref` still points
  at `sha`. `credentialRef` holds the name of the daemon environment variable its token is read
  from. git receives the token through a private askpass helper for the ref lookup and the clone
  alone, and atc never writes, logs, or stores it. The session's harness starts without that
  variable and without the askpass context, and the workspace it receives holds no credential.
- The daemon fetches over the transports in `workspaces.gitTransports`, `https` and `ssh` by
  default, the scp-style `user@host:path` counting as ssh. A `git` source on any other transport,
  such as `file://` or a local path by default, fails as `invalid_git_url` before git runs. Every
  git command the daemon runs carries `GIT_ALLOW_PROTOCOL` with the same list, so a host `insteadOf`
  rewrite, a `path` source's origin, or a submodule cannot reach another transport either. `ext::`
  and `fd::` are never allowed: the config refuses them.

`cwd` must not exist on the target. The daemon creates it before it clones, so a directory that
already exists refuses the spawn as `workspace_exists` and stays as it was. A refusal after that
removes the directory. A `path` source outside any git work tree runs in place on a `local-pty`
target, with `cwd` equal to its path; any other target refuses it as `not_a_git_repo`.

The daemon answers the spawn once the workspace is ready, and the session descriptor holds
`workspace`: `repoURL`, `sha`, `ref` when the commit came from a branch or tag, and
`materializedAt`. A target whose provider lacks `transfer` or `run` refuses the spawn as
`unsupported_operation` before any git command runs. The
[daemon architecture](./daemon.md#workspace-materialization) covers the phases.

Every workspace refusal holds the phase it failed in as `data.phase`, and its message and data hold
`[credential]` wherever the token's value would appear:

| Code                 | Phase                     | Refused when                                                                                    |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `not_a_git_repo`     | resolving                 | the path is not a directory inside a git work tree                                              |
| `no_commits`         | resolving                 | the checkout has no commit                                                                      |
| `unreadable_tree`    | resolving or cloning      | git cannot inspect the path, list the commit's tree, or read the checkout's status              |
| `has_submodules`     | resolving or cloning      | the commit holds a gitlink or a `.gitmodules` file                                              |
| `workspace_dirty`    | resolving                 | the checkout has uncommitted or untracked changes                                               |
| `no_origin`          | resolving                 | the checkout has no origin remote                                                               |
| `invalid_git_url`    | resolving                 | the URL does not read as a repository URL                                                       |
| `unpushed_head`      | resolving                 | origin does not hold HEAD                                                                       |
| `credential_in_url`  | resolving                 | the URL, or an `insteadOf` rewrite of it, carries a credential                                  |
| `workspace_exists`   | resolving                 | `cwd` exists on the target, as `data.dir`                                                       |
| `credential_missing` | cloning                   | the `credentialRef` variable is unset or empty                                                  |
| `ref_not_found`      | cloning                   | the upstream has no such branch, tag, or commit                                                 |
| `lfs_unsupported`    | cloning                   | a tracked path uses Git LFS, counted in `data.count`                                            |
| `clone_failed`       | cloning                   | git cannot clone the repository or check the commit out                                         |
| `sanitize_failed`    | cloning                   | the clone still holds a credential, or its history no longer reads                              |
| `tar_failed`         | cloning                   | tar cannot archive the clone                                                                    |
| `transfer_failed`    | resolving or transferring | the provider cannot create `cwd`'s parent or unpack the archive                                 |
| `workspace_mismatch` | verifying                 | the target's HEAD is not the pinned commit, in `data.actual`, or a tracked file differs from it |

## Sources

A source is where the spawn picker finds what a session runs in: directories on the daemon's host, a
GitHub account's repositories, or a typed git URL. `agents.list` returns the sources the daemon
offers in the order the picker shows them, each with its `id`, its `label`, and its `kind`, `path`
or `git`:

```jsonc
"sources": [{ "id": "dirs", "label": "directory on the daemon host", "kind": "path" },
            { "id": "github", "label": "GitHub repository", "kind": "git" },
            { "id": "git", "label": "git URL", "kind": "git" }]
```

The config's `workspaces.sources` sets the ids and their order, and without it the order is `dirs`,
`github`, `git`. The daemon leaves out a source its host cannot run: `github` needs `gh` on the
daemon's host, and `git` needs nothing beyond git. A daemon without the `sources` feature returns no
`sources`, and the picker then offers its local directory flow alone.

Every source request runs on the daemon's host and takes the `target` the spawn will run on. The
daemon checks that target as it checks a spawn's: a principal that may not use it gets
`target_forbidden`. A `git` source also needs a target whose provider has `transfer` and `run`, and
gets `unsupported_operation` otherwise. Without `target`, the check uses the default target. A
`source` the daemon does not offer is `unsupported`.

`sources.list` returns one source's candidates. Each holds a `label`, an optional `detail`, and a
`pick`: `{ kind: "path", dir }` for a directory on the daemon's host, or `{ kind: "git", url }` for
a repository, which `git.probe` pins to a commit before a spawn uses it. `scope` narrows the listing
the way the source defines, and the answer holds the scope it listed under, or null:

```jsonc
{ "v": 4, "id": 7, "m": "sources.list", "p": { "source": "github", "scope": "acme" } }

{ "v": 4, "id": 7, "ok": { "source": "github", "scope": "acme",
                           "candidates": [{ "label": "acme/app", "detail": "private",
                                            "pick": { "kind": "git",
                                                      "url": "git@github.com:acme/app.git" } }] } }
```

- `dirs` lists the spawn history, most recent first, then the directories under the configured
  `dirs.roots`, then zoxide's list on the daemon's host. It drops a directory that no longer exists.
  A label starts with `~` for a path under the daemon user's home.
- `github` lists one GitHub owner's repositories through the `gh` CLI, as the account `gh` is signed
  in to sees them, at the clone URL form `gh` is configured to prefer. The scope is the owner.
  Without one, it lists `workspaces.githubOwner`, and without that, the `gh` account's own
  repositories, and the answer's scope is then the login the first repository holds, or null for an
  empty list. A scope that is not a GitHub login is `bad_args`. A signed-out `gh` fails the request
  with `github_unavailable` and `data.problem` `not_authenticated`, and any other `gh` failure with
  `failed` and the message `gh` printed. A `gh` command that runs longer than 20 s fails the request
  the same way, with `failed`.
- `git` lists nothing.

`sources.interpret` returns what one source reads typed input as: `{ kind: "browse", scope }` for a
scope to list, a `path` or `git` pick, or `{ kind: "none" }` for input the source does not read.
`dirs` reads an absolute path, and a path that starts with `~`, which stands for the daemon user's
home. `github` reads `owner/` as that owner's scope, and `owner/repo` as that repository at the URL
form `gh` prefers. `git` reads a URL with a scheme, an scp-style `user@host:path`, or an absolute
path.

`git.probe` checks that the daemon's host can read a git source and lists its refs. It resolves the
URL exactly as a workspace spawn does and runs one `git ls-remote` that authenticates as the clone
would: through the host's git config, or through the `credentialRef` askpass helper. The answer
holds the URL the clone fetches, the upstream's default branch as `head`, every branch and tag with
the commit it points at, and `resolved`:

```jsonc
{ "v": 4, "id": 8, "m": "git.probe", "p": { "url": "acme/app", "ref": "main" } }

{ "v": 4, "id": 8, "ok": { "url": "https://github.com/acme/app.git", "head": "main",
                           "refs": [{ "name": "main", "kind": "branch", "sha": "c2e799e…" },
                                    { "name": "v1.0", "kind": "tag", "sha": "5807f22…" }],
                           "resolved": { "sha": "c2e799e…", "branch": "main" } } }
```

`resolved` is the commit `ref` points at now, resolved by the rules a spawn uses: a branch before a
same-named tag, and an annotated tag to the commit it points at. A `sha` resolves to itself, since a
ref listing never shows whether the upstream holds a commit; the clone checks that. Without either,
`resolved` is null. A client that spawns with both the resolved `sha` and its `ref` gets the commit
it showed, whatever lands on the branch in between. A refusal takes the code the same failure gets
in a spawn: `invalid_git_url`, `credential_in_url`, `credential_missing`, `clone_failed` with git's
own message for an upstream the host cannot read, and `ref_not_found`. A refusal of a GitHub
repository holds its other URL form, ssh for https and https for ssh, in `data.alternates`. A
`git ls-remote` that runs longer than 20 s is stopped and fails the request with `clone_failed`.

## Kill and sleep

`session.kill` on a live session ends its harness and the harnesses of its live sub-sessions, and
the session lists as exited. A second kill of a dead session forgets it: the daemon drops the
session and its dead sub-sessions from the list and the fleet. A dead sub-session whose own target
can destroy its host stays and becomes top-level, since forgetting it takes its own forget. A
headless run stops only with the session it belongs to: a sub-session that becomes top-level, or a
session whose kill or forget fails, keeps its run.

A session whose target can put its host to sleep owns a host of its own, and a sub-session on the
same target runs on its parent's host. A kill of the session that owns such a host puts the host to
sleep instead of ending anything: every harness on the host stays inside it, each of those sessions
lists as exited with `lastMsg` `asleep`, and its `lifecycle` reads `desired` `sleep`, `vm` `asleep`,
and `harness` `suspended`. A revive wakes the host and finds the harness as it was. A kill of a
sub-session on its parent's host ends that harness alone.

A host that another owner keeps awake refuses to sleep. The kill then fails whole with
`host_leased`, the session keeps running, and `data` holds `leases`, the other owners' leases the
host shows this daemon, and `otherCount`, the number of owners it does not show. The daemon never
forces a host to sleep.

A target that can destroy its host never forgets a session on a second kill, since forgetting the
session destroys the host and everything on it. The second kill fails with `confirmation_required`,
with the session id in `data.session`.

`session.forget` (`{ session, confirmToken? }`) forgets a session for good, live or dead. On a
target that cannot destroy its host, it forgets at once, the way a kill followed by a second kill
does, and answers `{ forgotten: true, destroyed: false }`. On a target that can, it takes two calls:

1. A forget without `confirmToken` checks the target and answers `{ confirmToken, expiresAt }`. It
   changes nothing.
2. A forget with that token destroys the host and answers `{ forgotten: true, destroyed: true }`.
   Every session on the host is forgotten with it.

The token belongs to one session and works once, until `expiresAt`, 60 seconds after the daemon
issued it. A forget whose token the daemon does not take fails with `confirm_token_invalid`, and
`data.reason` is `unknown` for a token issued for another session or never issued, `used` for a
token a forget already took, and `expired` for one past `expiresAt`. A forget that took a token and
then failed to destroy the host still used the token up. A sub-session on its parent's host is
forgotten alone: its harness ends, and the host stays. While that host sleeps, the sub-session's
process stays inside it, out of the daemon's reach, so its forget fails with
`unsupported_operation`, `data.problem` `host_asleep`, and the owner's id in `data.host`. Revive the
session first, or forget the owner, which destroys the host.

## Idempotent requests

A `session.spawn` or `session.message` that carries an `idempotencyKey` takes effect at most once
for that key. Retry a spawn with the same key and the same params, and the daemon answers with the
session the first spawn created instead of spawning another; a retried message gets the first
message's id instead of a second message. The key holds 1 to 200 characters, and the daemon keys it
per principal and method. A request that acts as a [principal](#principals) holds its keys apart
from every other principal's, and the daemon's owner acts as the principal `local`. The owner's
connection may act as any principal, keys included, which is how `atc mcp --http` holds each remote
client's keys under its client ID. On a connection that acts as a principal, every request holds its
keys under that principal, whatever principal it acts as.

The daemon records the key before it checks any param. A refused request drops the key again, so a
retry runs fresh. A spawn that fails after its process starts kills that process and drops its
session first. The daemon drops the key only once the process has exited and the fleet without that
session is written. The kill sends SIGHUP and waits 2 s for the exit. On a `local-pty` target, a
process still running then gets SIGKILL and 2 s more. When the process outlives those waits, or the
fleet write fails, the session may still stand, so the daemon keeps the key as `outcome_unknown` and
answers the spawn with that error. A session whose process outlived the waits stays listed. The
daemon refuses a `session.adopt` of that session as `no_such_session` while it waits for the exit,
and after it until it finds the process gone, so no revived process runs beside the first.

A spawn whose process started but whose fleet write fails gets `outcome_unknown` too, and its
session stays listed and running. A request whose key the daemon cannot mark completed gets
`outcome_unknown`, and its session or message stands. The daemon answers `outcome_unknown` with the
effect's id even when it cannot record that state in the key. The key then stays in progress, the
daemon answers a retry under it with the same error, and the daemon logs the failed write to stderr.

A retry of a key the daemon holds gets its answer from the key without any param checked again. The
daemon records the key with a SHA-256 of the request's params as it parsed them, as JSON with sorted
keys and without the key itself, so a default spelled out or a field the daemon ignores leaves the
hash unchanged. It records the id it mints for the effect before the effect runs as well: the new
session's id, or the new message's id. The daemon's answer to a retry depends on what the key holds:

- The same key with different params is `idempotency_conflict`.
- For a completed spawn, the daemon returns the session's current descriptor while it is listed,
  else the descriptor the first spawn returned.
- For a completed message, the daemon returns the message id with the message's current status.
- A request that a stopped daemon may or may not have run, a spawn whose failed start the daemon
  could not take back, or a request whose effect the daemon could not record, is `outcome_unknown`,
  with the session or message id in `err.data.effectRef`. The daemon never runs it again under that
  key; check the session or message and retry under a new key.

At start, before it serves a request, the daemon marks every key a stopped daemon left in progress
as `outcome_unknown`, then completes each `outcome_unknown` spawn key whose session is in the fleet
table and each `outcome_unknown` message key whose message row exists. A spawn key completed this
way has no stored answer, so a retry is `no_such_session` with `err.data.effectRef` until a fleet
restore lists the session; after that, the daemon returns its descriptor. The daemon keeps a
completed key for 24 hours and an `outcome_unknown` key indefinitely.

A failed spawn whose cleanup the daemon could not confirm, and whose session row is gone from the
fleet table at the next start, keeps its key as `outcome_unknown` for good: the hourly sweep expires
only completed keys. A retry under that key never spawns. Clearing such a key takes an operator: the
error's `err.data.effectRef` holds the session id the spawn minted, so the operator can look for
that session, kill it if it still runs, and spawn again under a new key. No atc command clears a
held key.

## Messages

A client sends a session a message with `session.message`, and the daemon keeps it in the session's
inbox until the session takes it. Messages live in `atc.db`, so they survive a daemon restart and a
fleet restore. The daemon never types a message into the session's terminal: a process inside the
session takes it through a tap.

A tap is a connection that sent `session.tap` for one session. `atc tap --session <id>` is that
client: it prints each message as one NDJSON line on stdout and acks it with `message.ack`. When a
tap attaches, the daemon sends every pending message in order, then each new one as it arrives.
`InboxMessage` and `InboxClosed` events go to the tap alone, the way `SessionOutput` goes only to
attached clients. A second tap for the same session replaces the first. The daemon sends the
replaced tap `InboxClosed` with reason `replaced`, or `removed` when the session itself goes away,
and `atc tap` exits on it.

A message moves through three statuses:

- `accepted`: the message is in the inbox.
- `delivered`: a tap printed the message and acked it.
- `answered`: the session reported the end of the turn that carried the message. The report arrives
  on the reporter socket from `atc report answered`, and that turn's final text becomes the answer.

An answer is the final output of the turn that carried the message, never a reply written to that
message alone. A message that arrives during a running turn joins that turn, so one turn can carry
several messages, and each of them gets the same answer. When a turn ends, the `atc-bridge` mod
sends one report holding every message the turn answered and the turn id. The daemon marks all of
them answered in one statement and stores the turn id on each, so a client that reads any of them as
`answered` finds the whole group answered too. `message.get` returns the turn id as `turn`, null
when the reporter sent none, and returns the other messages the same turn answered as
`answeredWith`, empty when there are none. A report from an older mod holds no turn id, so its
message stores null.

A session can report progress with no message attached: `atc report note` sends a labelled free-form
report, and the daemon broadcasts it as `SessionReport` with the session id, label (`kind`), text,
and time.

Each status change broadcasts `SessionMessage` with the message id, status, sender, timestamps, and
short previews of the text and answer. `message.get` returns the full text and answer.

`message.get` takes `waitMs` and holds the request until the message's status moves from what it was
when the request arrived, or the wait ends, for at most 30 seconds. An answered message has no later
status, so the daemon returns it at once. Message ids and statuses live in `atc.db`, so a client
whose wait ended, or whose connection dropped, calls again with the same id.

`session.message` refuses a message with `unsupported` in two cases:

- The session's agent has no tap. Claude and Claude gateways have one, and Grok and Codex do not.
- A Claude session reported `SessionStart` more than 15 seconds ago, and no tap has attached since.

Otherwise the message queues, including while a session restores and while a dropped tap reconnects.
A message to a session with no live process fails with `session_dead`.

### Session bridge

A session on a remote host reaches the daemon through its session bridge: one socket inside the host
per harness, which the host forwards to the daemon. It is a closed NDJSON dialect of its own. A line
without an `op` is a hook line, `{ atcId, event, payload }`, as the reporter socket takes it. A
request line is `{ v: 1, id, op, ... }` and gets one answer, `{ id, ok: true, ... }` or
`{ id, ok: false, code }`. The bridge writes `InboxMessage` and `InboxClosed` events to a tap as
protocol event lines.

| Op            | Does                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `report`      | apply `{ reportID, payload }`, a note or an answer; a resent note under the same `reportID` lands once |
| `tap.open`    | make this connection the session's tap                                                                 |
| `tap.ack`     | mark `{ message }` delivered, and return its `status`                                                  |
| `status.read` | the session's own `state` and `lastMsg`                                                                |

Every op acts on the session the bridge serves, and no request line holds a session id. The bridge
answers an unknown op, a malformed line, or a hook line for another session with `forbidden`, and
closes the connection. It answers `stale_binding` and closes the connection once the session is
gone, has moved to another target, identity, or host, or has started or attached a newer harness. It
answers an ack for a message the session does not hold with `unknown_message`, and an ack from a
connection that is not the tap with `not_tapping`.

## Events socket

A second listener, `atc-events.sock`, streams the broadcast events to anything that connects — no
handshake, no version negotiation, no requests. Every line already carries `v`, and the envelope
rule that unknown fields are ignored is the whole compatibility contract, so a subscriber written
against one atc version keeps working across upgrades that the strict client handshake would refuse.
The socket is read-only by construction: the daemon ignores anything written to it.

On connect, the daemon replays the current fleet as one `SessionAdded` line per session, then live
events behind it — snapshot-then-stream, the same trick as attach's screen replay, so a subscriber
never needs the client protocol to learn what exists. Each subscriber has a bounded outbound queue;
on overflow the daemon disconnects it, and a reconnect gets a fresh snapshot instead of the backlog
it missed. `SessionOutput` and `SessionDesync` never appear here — they are attach-scoped, not
broadcast. The [events guide](../guides/events.md) covers the consumers: daemon hooks, `atc events`,
and direct subscribers.

## Attach and streaming

The daemon reads every PTY continuously — background output is consumed, not discarded — and feeds
it to the per-session screen model. On attach, the daemon sends the current screen state (serialized
from the screen model) as ordinary `SessionOutput` events, then live output behind it; the client
cannot tell replay from live and does not need to.

Sessions have a `kind`: `pty` (output is terminal text) or `headless` (output is structured agent
messages, e.g. SDK sessions). Same attach flow, same events, different payload discipline — this is
one field now instead of a protocol version later.

## Backpressure

The invariant: a slow client never stalls the PTY reader or any other client. Delivery policy — not
serialization — is where output and control genuinely differ:

- Every client has a bounded outbound queue (~2 MiB). Bun's `socket.write()` returns bytes-accepted
  and drops the rest silently, so short-write handling with a `drain`-driven flush is mandatory, not
  optional; an early loss test (blast a slow reader, assert zero loss) guards it.
- Output is droppable: if a client's queued output for a session overflows, the daemon discards that
  session's backlog, emits `SessionDesync` (with dropped byte count), and resynchronizes the screen
  when the queue drains — a full repaint from the screen model. A lagging client wants current
  state, not the backlog it missed. Intermediate ANSI chunks are never dropped without a resync,
  because a byte stream cut mid-escape corrupts the client's terminal state.
- Control is not droppable: a control-queue overflow is a bug or a hostile peer — disconnect.
- `headless` sessions never drop-and-resync (structured messages are semantic, not idempotent screen
  state): their queue is bounded and overflow fails the attach with `too_slow`. The transcript on
  disk is the durable copy; the socket is not a durability layer.

## Permissions

`PermissionRequested` broadcasts to all clients with a `respondable` flag. Every request is
synthesized from the Claude Code `Notification` hook and carries `respondable: false`: a PTY session
is answered with keystrokes in its terminal, and `permission.respond` against it returns
`unsupported`. A session that can take a structured answer raises the same event with
`respondable: true`, and clients need no new shape for it. Arbitration is first-response-wins: the
first `permission.respond` gets `ok`, the resolution broadcasts as `PermissionResolved` so every
client dismisses its prompt, and later responders get `already_answered`. A request times out to
deny; a client disconnecting never resolves a request by itself.

## Limits and violations

Line length is capped (1 MiB control, 64 KiB output chunks — the daemon splits larger PTY reads) and
enforced before buffering. The output-chunk cap also bounds head-of-line blocking: control and
output share one ordered socket by design (ordering by construction beats a second connection's
lifecycle and auth complexity), and a queued response can be delayed by at most one chunk. If that
ever hurts over a high-latency tunnel, the designed escape hatch is a resumption token in the
handshake result that lets a second data-only connection join the same client session — additive, no
framing change. There is no resync-by-scanning: transports guarantee byte integrity, so a malformed
line or oversized frame means a buggy or hostile peer, and the connection closes with a clear error.
Lifecycle is always explicit protocol messages — detach, kill, shutdown — never inferred from socket
half-close; a dropped connection implies only detach-all for that client's subscriptions.
