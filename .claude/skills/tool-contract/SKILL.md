---
name: tool-contract
description:
  The rules for atc's MCP tools and the atc-bridge tools — names, description order, result words,
  limits, output schemas, known-bug clauses, evidence, renames and vocabulary — each with an example
  from the current tools. Load before adding, renaming, or redescribing a tool in
  packages/mcp/src/tools/ or mods/atc-bridge/, or before reviewing such a change.
---

# atc tool contract

An agent that calls an atc tool knows only the tool's name, its description, and its input schema.
Many MCP clients never show the output schema to the model. The agent reads that text once, at the
moment it picks a tool, and acts on what it infers. A tool description therefore has two jobs: lead
the agent to the right tool, and stop it from reading more into a result than the result shows.

The tools live in three files:
[`packages/mcp/src/tools/mcp-tools.ts`](../../../packages/mcp/src/tools/mcp-tools.ts) holds the
names, descriptions, and schemas,
[`packages/mcp/src/tools/build-spawn-descriptions.ts`](../../../packages/mcp/src/tools/build-spawn-descriptions.ts)
builds the spawn description with the daemon's agents, and
[`mods/atc-bridge/hooks/register.ts`](../../../mods/atc-bridge/hooks/register.ts) registers the
bridge's `note` tool inside a Claude session. The handlers behind the MCP tools are in
[`packages/mcp/src/tools/run-tool.ts`](../../../packages/mcp/src/tools/run-tool.ts).

## Key rules

Each line links the section that explains it.

- [How the descriptions are written](#how-the-descriptions-are-written): find the wrong guess an
  agent would make, and write the sentence that closes it.
- [Rules](#rules)
  - [1. Name the channel, then the verb](#1-name-the-channel-then-the-verb): `atc_<noun>_<verb>` for
    an `atc mcp` tool, one word for a bridge tool, and no implied capability.
  - [2. Order the description: what, instead, result, limits](#2-order-the-description-what-instead-result-limits):
    a harmful limit comes straight after the first sentence.
  - [3. Say what the result shows, and the read that shows more](#3-say-what-the-result-shows-and-the-read-that-shows-more):
    a result word claims only the evidence atc holds.
  - [4. State the limits and side effects an agent could miss](#4-state-the-limits-and-side-effects-an-agent-could-miss):
    a destructive effect gets its guard in the description.
  - [5. Put field meanings in the output schema](#5-put-field-meanings-in-the-output-schema): the
    description keeps one sentence on partial or failing results.
  - [6. Keep output schemas open](#6-keep-output-schemas-open): no `enum` and no closed objects in
    an output schema.
  - [7. State a known bug plainly, and remove the clause with the fix](#7-state-a-known-bug-plainly-and-remove-the-clause-with-the-fix):
    no issue reference in the clause.
  - [8. Check every claim against the code or a live run](#8-check-every-claim-against-the-code-or-a-live-run):
    leave out a claim you could not check.
  - [9. Rename with a break, never an alias](#9-rename-with-a-break-never-an-alias): an old name or
    an old daemon is refused.
  - [10. Use one word per concept everywhere](#10-use-one-word-per-concept-everywhere): a rename
    covers the tools, events, CLI, wire protocol, and docs in one change.
- [Checking a change](#checking-a-change): read as a newcomer, record each claim's evidence, and
  search for renamed words.

## How the descriptions are written

Write each description for the wrong guess an agent would otherwise make, and close it. Find that
guess first, then write the sentence that removes it:

- An agent that sees a session waiting on input reaches for the terminal. On a menu, typed text is
  dropped and Enter picks the highlighted option: `yes` typed at the folder-trust dialog picks
  `No, exit`, and the session exits. So the `atc_terminal_type` description states that the tool
  cannot answer a menu, and the `atc_terminal_read` and `atc_session_get` descriptions never suggest
  typing an answer.
- An agent reads a status word as the strongest thing it could mean. A message waiting in atc's
  inbox is `queued`, a word no agent reads as "the agent took it".
- An agent told only what it cannot do guesses what to do instead. Each refusal or limit points to
  the path that works, such as a person in the TUI, or `atc_message_send` for an agent that takes
  messages.

Describe the tool as it behaves, not as it was meant to behave. A description cannot fix a runtime
bug: it states the bug so the agent works around it (rule 7), and the fix belongs to its own change.

Keep the description to what the agent decides with. A description that restates the output schema
field by field buries the sentence that prevents a mistake; field meanings go in the schema (rule
5). Write the description in the plain present tense of the `docs-writing` skill. The agent reads it
literally, so a soft word ("usually", "should") becomes a guess.

## Rules

Every rule below carries one example quoted from the current tools.

### 1. Name the channel, then the verb

An `atc mcp` tool name is `atc_<noun>_<verb>`, and the noun is the channel the call reaches. A noun
or verb of two words joins them with an underscore (`atc_spawn_options_get`,
`atc_session_mark_read`). `atc_terminal_type` types into the session's terminal, `atc_message_send`
sends into the agent's conversation, and `atc_transcript_read` reads the conversation log, so the
name alone separates three ways to reach one session.

A bridge tool takes a single verb or noun, because Claude Code already puts it in the bridge's own
`mcp__atc-bridge__` namespace: the bridge's tool is `note`, which the model calls as
`mcp__atc-bridge__note`.

A name never implies a capability the tool lacks. `atc_session_stop` stops the process and keeps the
session listed; removal has its own name, `atc_session_forget`.

### 2. Order the description: what, instead, result, limits

The first sentence states what the tool does and on which channel. Then comes when to use a
different tool instead, then what the result means, then the limits. One exception: a limit whose
misuse does harm comes straight after the first sentence. `atc_terminal_type` shows both:

> Type a line into a session's terminal and press Enter, as a person at the keyboard would. This
> tool cannot answer a menu: … When the agent takes messages (capabilities.message true in
> atc_spawn_options_get), use atc_message_send instead: … Returns { written: true } once the line
> reaches the terminal; … The text goes in as one paste, newlines included, whenever the agent's
> terminal takes pastes, …

### 3. Say what the result shows, and the read that shows more

A result word states the evidence atc holds and no more: written, queued, delivered, answered. When
the caller needs a stronger outcome, the description gives the follow-up read that establishes it.
`atc_terminal_type`:

> Returns { written: true } once the line reaches the terminal; that does not show the agent took
> it, so check with atc_terminal_read or atc_events_read.

### 4. State the limits and side effects an agent could miss

State what the tool cannot do, what it destroys, its defaults, and what a repeated call or a retry
does. A destructive effect gets its guard in the description itself. `atc_session_forget`:

> On an imp target this destroys the host and everything on it, so it takes two calls: the first
> changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token,
> returns { forgotten: true, destroyed: true }.

### 5. Put field meanings in the output schema

Each output-schema property's `description` holds what the field means. The tool description keeps
one sentence saying that a partial or failing result is flagged and where to look, because many
clients never show the output schema to the model. `atc_events_read` keeps that sentence:

> A partial read says so: complete false or textError on a note or an answer, and, under the
> gateway, unavailable, started or truncated, with their meanings in the output schema.

and its schema holds the meaning: `complete` is "false: atc kept only the preview of this note or
answer, and text holds it". A list the agent needs before it calls stays in the description, and the
property points there: the event `kind` is "the event kind; the tool description lists them".

### 6. Keep output schemas open

An output schema holds no `enum`, and its objects leave further properties open, so a field or kind
a later daemon adds never fails a client that validates results. The event `kind` is
`{ type: 'string' }` with the values listed in prose, and
[`mcp-tools.ts`](../../../packages/mcp/src/tools/mcp-tools.ts) states the rule above the schemas:

> Output schemas leave further properties open, so a field the daemon adds later never fails a
> client that validates results against them.

Input schemas may hold an `enum`: the bridge `note` tool's `label` takes `progress`, `blocked`, or
`decision`, and the tool denies any other value.

### 7. State a known bug plainly, and remove the clause with the fix

A clause that states a known bug holds no issue reference, and the change that fixes the bug removes
the clause. A clause of that shape, as an illustration:

> A message whose turn is interrupted stays delivered.

The bug's own issue records the clause, so the fix finds it.

### 8. Check every claim against the code or a live run

Each claim in a description holds against the code (file and line) or a live run on a dev daemon,
which runs from source in a state directory of its own (see the
[runtime rules](../../../AGENTS.md#runtime-rules) in AGENTS.md). Mark a claim you could not check as
unverified in the PR, and leave it out of the description. Never describe behaviour from memory. The
`atc_terminal_type` description says the text goes in as one paste whenever the agent's terminal
takes pastes, and gives no threshold: the paste threshold belongs to the agent CLI, and nothing in
atc's code holds it.

### 9. Rename with a break, never an alias

A tool rename is a breaking change with no alias in code. The old name is refused: `unknown tool` on
stdio, or a missing-scope refusal for a remote client without the `kill` scope, since a name atc
does not know needs the strictest scope. No tool translates an old daemon's words, because a daemon
on another protocol version refuses the handshake with `protocol_mismatch` before any tool call
reaches it ([the protocol](../../../docs/architecture/protocol/protocol.md#versions)).

### 10. Use one word per concept everywhere

One concept keeps one word across the tools, the event kinds, the CLI, the wire protocol, and the
docs. A rename of the concept covers all of them in one change. A session's progress message is a
note in the bridge `note` tool, the `atc note` command, the `note` event kind, and
`atc_events_read`'s "notes (note, with its label and full text)". A message waiting in atc's inbox
is `queued` in the status, the `message-queued` event, and the docs.

## Checking a change

Before you open a PR that adds or changes a tool:

- Read the description as an agent that has never seen atc: list the wrong guesses it allows, and
  close each one or name it in the PR.
- Check each claim against the handler in
  [`run-tool.ts`](../../../packages/mcp/src/tools/run-tool.ts) and the daemon code behind it, and
  record the file and line for each claim in the PR.
- Run the misuse a description warns about on a dev daemon when the code alone cannot show it, such
  as text typed into a menu.
- Search the tools, the event kinds, the CLI, and `docs/` for any word the change renames.
