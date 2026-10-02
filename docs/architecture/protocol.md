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
`already_answered`, `too_slow`, `stale_epoch`, `idempotency_conflict`, `outcome_unknown`,
`internal`. An unknown method is an `unknown_method` error, never a disconnect; unknown fields in
any message are ignored. A peer decodes an error code it does not know as `internal` and keeps its
`msg`. These rules exist so additive evolution never breaks a peer. An error may also carry `data`,
an object whose fields its code defines.

`unsupported_operation` refuses a request that the session's execution host cannot serve, such as
input to a host that takes none. Its `data` holds the provider kind as `provider` and the missing
capability as `capability`. The [daemon architecture](./daemon.md#execution-providers) covers
providers and their capabilities.

## Handshake

The first line on a connection must be `daemon.hello`; the daemon answers nothing else before it.
Versioning is a single integer with strict equality — daemon and client ship from the same repo, so
the only mismatch that happens in practice is a long-running daemon outliving an upgrade. The
failure must be actionable, not cryptic: the error names both versions and both build strings and
says to restart the daemon.

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
                                        "request.principal"],
                           "lastUsedAgent": "claude" } }
```

`features` lists the request features the daemon serves beyond the protocol version: `agents.list`
exists, `events.read` returns `more` and takes `session`, and `message.get` returns `turn` and
`answeredWith` and takes `waitMs`, `session.spawn` takes `model` and `effort` while `agents.list`
returns `spawnOptions`, `daemon.hello` returns `daemonID`, every session descriptor holds a
`locator`, `session.spawn` and `session.message` each take `idempotencyKey`, `session.spawn` takes
`target` while `agents.list` returns `targets`, and a request takes `as` while `daemon.hello` takes
`principal`. A daemon from before the list existed sends none, and it ignores the parameters it does
not know. A client that outlives a daemon upgrade, such as `atc mcp`, reads the list rather than the
build string to learn what the running daemon honours.

`daemonID` is the id the daemon minted into its state store the first time it opened it, so it stays
the same across daemon restarts. Every session descriptor holds a `locator` of
`{ daemonID, targetID }`: the daemon that hosts the session, and the [execution target](#targets) it
runs on.

`lastUsedAgent` is the agent id of the last deliberate spawn that reported SessionStart. The
built-in ids are `claude`, `grok`, and `codex`. A spawn that never reports SessionStart does not
change it. A fleet restore SessionStart does not change it. MCP spawn ignores the value and defaults
to Claude.

`auth` is present from day one (`{"scheme": "none"}` on the unix socket) so a TCP or SSH transport
later adds a scheme, not a handshake redesign. The transport is assumed to be an ordered, reliable
byte stream and nothing more — no unix-socket peer credentials or filesystem paths in message
semantics.

## Methods

| Method                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon.hello`          | handshake; must be first. The ok includes `lastUsedAgent`, the agent id written on a deliberate-spawn SessionStart.                                                                                                                                                                                                                                                                                                                                                        |
| `daemon.ping`           | liveness / latency probe                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `daemon.quit`           | stop the daemon; every hosted session goes down with it                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.list`          | fleet listing (descriptors mirror the `Session` shape, minus the PTY handle, plus `kind` and `agent`)                                                                                                                                                                                                                                                                                                                                                                      |
| `dirs.list`             | recent spawn directories, most recent first, for the picker                                                                                                                                                                                                                                                                                                                                                                                                                |
| `agents.list`           | the registered agents and the host the daemon runs on. [Agents](#agents) covers the answer                                                                                                                                                                                                                                                                                                                                                                                 |
| `fleet.list`            | the persisted fleet rows, independent of which sessions are currently live. Each row holds its `sessionID`, the `agentSessionID` once the agent reports one, and `parent` as an atc session id.                                                                                                                                                                                                                                                                            |
| `session.spawn`         | spawn (cwd, name, prompt, resume, dims, optional `agent` id, optional `parent` id, optional `model` and `effort`, optional `idempotencyKey`, optional `target`). Omitted agent is Claude, an empty id is `bad_args`, an unregistered one `unsupported`. An unknown parent is `no_such_session`. [Spawn options](#spawn-options) covers `model` and `effort`, [idempotent requests](#idempotent-requests) covers `idempotencyKey`, and [targets](#targets) covers `target`. |
| `session.update`        | rename and/or pin a session (`{ session, name?, pinned? }`). Pinning a sub-session is `bad_args`: it pins with its parent.                                                                                                                                                                                                                                                                                                                                                 |
| `session.kill`          | kill process; explicit, never implied by disconnect                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.ack`           | clear unread without attaching                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.attach`        | subscribe to a session's output; returns replay + current dims                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.detach`        | unsubscribe; session keeps running                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.input`         | keyboard input to a session (`{ session, d }`)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.resize`        | client reports its dims; effective size is the min across attached clients (broadcast as `SessionResized`)                                                                                                                                                                                                                                                                                                                                                                 |
| `session.resumeCommand` | build the resume command for that session's agent (`claude --resume`, `grok --resume`, or `codex resume`)                                                                                                                                                                                                                                                                                                                                                                  |
| `session.screen`        | the session's visible screen as plain text (`{ text, cols, rows }`), no attach needed; a killed session keeps its last screen                                                                                                                                                                                                                                                                                                                                              |
| `session.eject`         | hand a live session off to a headless run so it keeps working unattended                                                                                                                                                                                                                                                                                                                                                                                                   |
| `session.adopt`         | bring a dead or headless session back onto a live terminal                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `fleet.restore`         | cold-boot recovery: respawn the persisted fleet                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `permission.respond`    | answer a permission request (`{ request, decision }`)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `session.get`           | one session's descriptor plus its spawn prompt, last activity, pending prompt, and latest result (`{ session }`)                                                                                                                                                                                                                                                                                                                                                           |
| `session.read`          | a Claude session's transcript, a page at a time from a cursor (`{ session, cursor?, limit? }`)                                                                                                                                                                                                                                                                                                                                                                             |
| `events.read`           | fleet events from the hook-event trail since a cursor (`{ cursor?, limit?, waitMs?, session? }`)                                                                                                                                                                                                                                                                                                                                                                           |
| `session.message`       | queue a message for a session (`{ session, from, text, idempotencyKey? }`); the ok holds the message id. [Messages](#messages) covers refusals, and [idempotent requests](#idempotent-requests) covers `idempotencyKey`                                                                                                                                                                                                                                                    |
| `session.tap`           | subscribe to a session's inbox; messages arrive as `InboxMessage` events                                                                                                                                                                                                                                                                                                                                                                                                   |
| `message.ack`           | mark a tapped message delivered (`{ session, message }`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `message.get`           | one message with its status, answer, turn, and timestamps (`{ message, waitMs? }`)                                                                                                                                                                                                                                                                                                                                                                                         |

`session.input` is a request (it gets an ok, preserving the rule that state-changing messages are
acknowledged) but clients need not await it — measured cost of the JSON round trip is ~0.2 µs
against a ~3 µs socket round trip. Ordering between input, resize, and output is guaranteed by
construction: one socket, one ordered stream.

Multi-client rules, chosen to cover the realistic conflicts without a write-lock protocol:

- Input atomicity: a client sends one complete key event or one complete paste per `session.input`;
  the daemon writes each input payload to the PTY whole, never interleaving bytes from two clients
  inside one payload. Client input is decoded statefully per client so a multi-byte character split
  across reads is never mangled.
- Resize debounce: the daemon debounces effective-dimension changes (~50 ms) and suppresses PTY
  resizes when the effective size is unchanged, so two clients resizing in opposite directions
  cannot produce a SIGWINCH storm.

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
  characters of its text.

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
may use. Each target grant matches a target name and its identity now, and a session is within the
principal's reach when its target and bound identity match a grant. To a principal, a session out of
reach does not exist:

- `session.list`, `fleet.list`, and `events.read` leave it out, and the daemon reads `events.read`
  filtered to it as a filter on a session the trail never held.
- The daemon refuses every request that takes its session id, or the id of one of its messages, as
  it refuses one for an unknown id, with the same code, message, and `data`.
- `agents.list` lists only the targets the principal may use, and `spawnDefaults.target` is null
  when the principal may not use the default.
- A connection that acts as a principal is pushed only the events of sessions within reach, and a
  permission request's resolution only when it was pushed the request.

A spawn to a target the principal may not use, named or the default, fails with `target_forbidden`,
with the target as `data.target`. `daemon.quit` and `fleet.restore` act on the whole daemon, and a
principal gets `unauthorized` for them. The [events socket](#events-socket) has no handshake and
streams every event: it is a local socket for the daemon's owner alone.

## Idempotent requests

A `session.spawn` or `session.message` that carries an `idempotencyKey` takes effect at most once
for that key. Retry a spawn with the same key and the same params, and the daemon answers with the
session the first spawn created instead of spawning another; a retried message gets the first
message's id instead of a second message. The key holds 1 to 200 characters, and the daemon keys it
per principal and method. A request that acts as a [principal](#principals) holds its keys apart
from every other principal's, and the daemon's owner acts as the principal `local`.

The daemon records the key before it checks any param. A refused request drops the key again, so a
retry runs fresh. A spawn that fails after its process starts kills that process and drops its
session first, and drops the key only once the kill succeeds and the fleet without that session is
written. When either step fails, the session may still stand, so the daemon keeps the key as
`outcome_unknown` and answers the spawn with that error. A retry of a key the daemon holds gets its
answer from the key without any param checked again. The daemon records the key with a SHA-256 of
the request's params as it parsed them, as JSON with sorted keys and without the key itself, so a
default spelled out or a field the daemon ignores leaves the hash unchanged. It records the id it
mints for the effect before the effect runs as well: the new session's id, or the new message's id.
The daemon's answer to a retry depends on what the key holds:

- The same key with different params is `idempotency_conflict`.
- For a completed spawn, the daemon returns the session's current descriptor while it is listed,
  else the descriptor the first spawn returned.
- For a completed message, the daemon returns the message id with the message's current status.
- A request that a stopped daemon may or may not have run, or a spawn whose failed start the daemon
  could not take back, is `outcome_unknown`, with the session or message id in `err.data.effectRef`.
  The daemon never runs it again under that key; check the session or message and retry under a new
  key.

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
