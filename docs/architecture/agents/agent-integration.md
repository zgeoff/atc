# Agent integration

atc learns what an agent is doing from the agent's own hooks: each hook runs a short atc helper that
sends the event to the daemon's reporter socket. How the hooks get into the agent differs per agent,
under one rule: atc never writes into an agent's own config. Claude Code takes everything per
invocation, through files atc writes and passes on the command line. Grok and Codex take hooks only
from their own config, so atc prints the hook file and the owner installs it once. One exception: a
Codex session that signs in through impd's broker gets a Codex home of its own, and atc writes the
hooks there ([Grok and Codex](#grok-and-codex)).

[Adapters](./adapters.md) covers the adapter each agent runs through, and
[messages](../protocol/messages.md) covers the inbox the `atc-bridge` mod serves.

## Session helpers

The hooks run `atc hook-report`, which sends the hook's JSON to the reporter socket of the session's
daemon. The helper always exits 0 and drops the report when no daemon answers, because a broken
reporter must never break the session it reports on. Each hook command carries the agent id of the
session's entry. A harness nested inside a session inherits the session's environment but not its
command line, so the daemon drops a report whose agent id differs from the session's, and a nested
agent never reports as the session it runs in.

The agent's start report carries its agent session id, which is what makes a session restorable
before the owner has typed anything ([fleet and restore](../daemon/fleet-and-restore.md)).

## Claude Code

Every Claude Code session starts with files atc wrote for it:

- **A generated settings file**, passed with `--settings`, holds the atc hooks for start, end,
  prompt submit, notification and stop, and a chained statusline. Hooks that an entry's extra
  session settings add run after atc's own, so they join the reporter rather than replacing it.
- **The `atc-bridge` mod**, passed with `--plugin-dir`, connects the session to its inbox and gives
  the model a `note` tool.
- **A scratch folder of its own**, passed as an added directory and as `TMPDIR`, so a session's
  temporary files never land in another session's.

The chained statusline runs the owner's own configured statusline first, then appends a fleet
segment read from `status.json`, so fleet state shows inside Claude Code's own status line while the
owner is attached. Each statusline render also sends its input to the daemon as a heartbeat, a
second path for capturing the agent session id.

Session names come from Claude Code's transcript: a title the owner set with `/rename`, else the
summary Claude Code wrote.

A session that signs in through impd's broker on an imp gets a Claude Code config folder of its own
in its guest folder, seeded with the onboarding state and trust marks a fresh folder would otherwise
prompt for. The folder also holds a sign-in file whose access token is the broker placeholder.
Claude Code removes its credential variables from the environment of every tool it runs, so a Claude
Code CLI that a tool starts finds its sign-in only in that file. A stock Claude Code session there
also takes an allow-listed copy of the daemon host's own Claude Code config at each launch, which
atc reads and never writes. One exception to the rule that atc never writes an agent's config: a
local launch that opts into clone trust adds one folder-trust entry for its verified clone to the
owner's Claude Code config, under Claude Code's own lock, since Claude Code takes trust no other
way.

## The atc-bridge mod

The mod is a Claude Code plugin of function hooks. Its source lives in the repo's `mods/` folder,
and the build embeds it in atc, so a compiled binary can write it out. The daemon writes the mod
into its state directory with the atc command it should run rendered in, and rewrites only a file
whose content changed, because any write reloads the mod in every running session. A headless run
gets the same mod through the Agent SDK. Outside atc, with no atc session id in its environment, the
mod does nothing.

At session start, the mod starts `atc tap` for the session and hands each message to the model
inside an `<atc-message>` envelope that holds the sender and the message id, as a new turn when the
session is idle and inside the running turn otherwise. The mod adds a section to the system prompt
that says what the envelope means, so the model treats a relayed message as one from another tool
rather than the owner's own words. When a turn that carried messages ends with a reply, the mod
reports every message the turn carried as answered with that reply and the turn's id, in one call; a
turn that ends without a reply is reported as unanswered, with the cause
([messages](../protocol/messages.md#answers)).

The `note` tool sends progress mid-turn, labelled `progress`, `blocked` or `decision`, and never
answers a message. The mods API is early access, so CI validates and tests the mod against one
pinned Claude Code version.

## Grok and Codex

Grok takes its hooks from a file in its own hooks folder, which `atc grok-hooks` prints. The
reporter translates Grok's envelopes into the same reports, and the adapter filters a stale prompt
report and treats Grok's idle prompt as a finished turn. atc appends `--no-leader` to every Grok
spawn, so the hosted TUI never takes atc's leader key. Grok session names come from its session
summary.

Codex takes its hooks from entries in its own hooks file, which `atc codex-hooks` prints, and runs
them only after the owner trusts them once in the Codex TUI. A Codex session that signs in through
impd's broker on an imp instead gets a Codex home of its own in its guest folder, with a sign-in
file that holds no credential and the hook entries, which it runs without the trust step. Codex
session names come from its session index.

Neither Grok nor Codex has a message tap, a transcript reader or a headless runner, so the daemon
refuses a message, a transcript read and an eject for their sessions.
