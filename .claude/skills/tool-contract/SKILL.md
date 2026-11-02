---
name: tool-contract
description:
  "The rules for atc's tools: the MCP tools that `atc mcp` serves and the tools of the atc-bridge
  Claude Code mod. Covers names, the order of a description, result words, limits, output schemas,
  known bugs, evidence and renames. Load it before you add, rename or redescribe a tool in
  packages/mcp/src/tools/ or mods/atc-bridge/, or before you review such a change."
metadata:
  kind: rule-set
---

# atc tool contract

## Where the tools live

- Find each tool that `atc mcp` serves to an MCP client in
  [`mcp-tools.ts`](../../../packages/mcp/src/tools/mcp-tools.ts): its name, description and schemas.
  Its handler is in [`run-tool.ts`](../../../packages/mcp/src/tools/run-tool.ts).
- Change the spawn tool's description in
  [`build-spawn-descriptions.ts`](../../../packages/mcp/src/tools/build-spawn-descriptions.ts),
  which adds the daemon's agents to it.
- Change the bridge's `note` tool in [`register.ts`](../../../mods/atc-bridge/hooks/register.ts).
  atc-bridge is a Claude Code mod that registers it inside a Claude session.

## Write for the wrong guess

An agent sees only a tool's name, its description and its input schema, and an MCP client may never
show it the output schema. So find the wrong guess an agent would make from that text, and write the
sentence that rules it out.

- Say in `atc_terminal_type` that it can't answer a menu, and never suggest typing an answer in
  `atc_terminal_read` or `atc_session_get`. An agent that sees a session waiting on input reaches
  for the terminal, but on a menu typed text is dropped and Enter picks the highlighted option, so
  `yes` typed at a trust dialog can pick "No, exit".
- Describe the tool as it behaves. A description can't fix a bug: state it, as
  [Known bugs](#known-bugs) says, and fix it in its own change.
- Leave out a sentence that only restates the output schema. It buries the sentence that prevents a
  mistake. Put what each field means in the schema, as [Output schemas](#output-schemas) says.
- Before the PR, read each description you changed as an agent that has never seen atc. Rule out
  each wrong guess it allows, or name it in the PR.
- Write in the plain present tense. The agent reads the text literally, so "usually" or "should"
  becomes a guess.

## Names

- Name an `atc mcp` tool `atc_<noun>_<verb>`. Make the noun the thing the call acts on, such as
  `terminal` for the session's terminal, `message` for the agent's conversation and `transcript` for
  its log. Join a two-word noun or verb with an underscore, as in `atc_session_mark_read`.
- Name a bridge tool with one word, such as `note`. Claude Code adds the `mcp__atc-bridge__` prefix.
- Never let a name promise what the tool doesn't do. `atc_session_stop` stops the process and keeps
  the session listed, so removing it is a separate tool, `atc_session_forget`.

## Description order

Write a description in this order, and skip a step that doesn't apply to the tool.
`atc_terminal_type` in [`mcp-tools.ts`](../../../packages/mcp/src/tools/mcp-tools.ts) follows it.

1. Say what the tool does, and on what.
2. When a misuse does harm, say so next.
3. When another tool fits a case better, name it and the case, such as asking a person to use atc's
   terminal UI, or `atc_message_send` for an agent that takes messages.
4. Say what the result means, when the result word alone doesn't, and name any partial or failing
   result.
5. Give the other limits: what the tool destroys, its defaults, and what a repeat or a retry does.

## Result words

- Pick a word for the result, as a field or a status value, that claims only what atc knows, such as
  `written`, `queued`, `delivered` or `answered`. An agent reads a result word in its strongest
  meaning, so a message atc holds before the agent takes it is `queued`, never "sent".
- When the caller needs more, name the tool that shows it. `atc_terminal_type` returns
  `written: true`, and says to check with `atc_terminal_read` or `atc_events_read` whether the agent
  took the line.

## Destructive tools

- When a tool destroys what can't be got back, make its handler take two calls, and say so in the
  description. `atc_session_forget` on an imp target, a session on a remote host that atc made,
  destroys that host. Its first call returns a `confirmToken`, and only a second call with that
  token destroys the host.

## Output schemas

- Write what each field means in its `description` in the output schema.
- When a tool can return a partial or failing result, add one sentence to its description that says
  so and names the fields to read, as `atc_events_read` does. A client that hides the schema still
  shows that sentence.
- When a caller needs a list to read a result field, such as the event kinds in `atc_events_read`,
  put the list in the tool's description, and make the field's `description` point there.
- Never put an `enum` in an output schema, and never set `additionalProperties: false` on one. A
  client that checks results against a closed schema rejects a field or a value that a later daemon
  adds. An input schema may close its properties and use an `enum`.

## Known bugs

- State a known bug in the description with no issue reference, such as this invented one: "A
  message whose turn is interrupted stays delivered."
- Quote that sentence in the bug's issue, so whoever fixes the bug finds it. Remove it in the change
  that fixes the bug.

## Evidence

- Check each claim in a description against the handler and the daemon code behind it, or against a
  run on a dev daemon, which runs from source in its own state folder, as the
  [runtime rules](../../../AGENTS.md#runtime-rules) in AGENTS.md say.
- Record the file and line, or the run, for each claim in the PR.
- Leave out a claim you couldn't check, and say so in the PR. `atc_terminal_type` gives no paste
  limit, because the agent CLI sets it and nothing in atc holds it.
- When the code alone can't show a misuse, such as text typed into a menu, run it on a dev daemon.

## Renames

- Remove a tool's old name in the same change that adds the new one, with no alias. atc answers an
  unknown name with `unknown tool`.
- Use one word for one idea across the tools, the event kinds, the CLI, the protocol and `docs/`. A
  progress message is a note in the `note` tool, the `atc note` command and the `note` event kind.
- When you rename an idea, search the tools, the event kinds, the CLI, the protocol and `docs/` for
  the old word, and rename every use in the same change.
