# Adapters

An adapter is everything atc knows about one agent CLI. The daemon's session core never sees past
the adapter interface, so a new agent CLI is a new adapter, not a change to the core. Each adapter
plans how its agent starts on a local or a remote host, maps the agent's hook reports to atc's
attention kinds, reads the agent's session names, builds its resume command, and declares what it
supports: transcript reads, a headless runner, a message tap, and how a submitted line is typed.

[Agent integration](./agent-integration.md) covers how each agent reports to atc, and
[sessions](../daemon/sessions.md) covers what the core does with the reports.

## The registry

The config's `agents` map is the registry. It holds exactly the agents atc offers, one adapter per
entry in file order, keyed by the entry's id, and each entry's kind picks the CLI it drives: Claude
Code, Codex or Grok. Several entries can share a kind, such as two Codex entries with different
arguments. A session records its agent by id, so the daemon finds the session's adapter by that id
for every later step, and a fleet row whose id the registry no longer holds refuses to revive rather
than coming back under another agent.

A Claude Code entry with a base URL is a gateway agent: the Claude Code CLI pointed at a
Claude-compatible backend. It gets its own picker row, its own fleet rows and its own generated
settings file, which carries the backend's URL. The terminal spawn and a headless turn both take
that file, so a gateway session ejected to a headless run stays on its backend. The credential never
goes in the file: a helper command supplies it, or impd's broker on an imp
([runtime auth](../execution/runtime-auth.md)).

## Hook state

An adapter reads each hook line as the events it means for the session, and reading a line can
depend on earlier lines, such as which prompt is the latest one. The daemon holds that state for the
adapter, one value per session: it passes the value the adapter returned for a session's previous
line back with that session's next line, and the value starts empty each time the session's terminal
boots. An adapter therefore keeps no state of its own, and one session's lines never change how
another session's lines read.

## Choosing an agent

The spawn picker resolves each agent's binary as it opens and lists only the agents that resolve, so
every row is a session that can start, and an uninstalled agent never shows up later as a terminal
that dies on exec. A picker with one row is no choice, so the flow takes that agent without showing
the picker. The opening selection is the last agent the owner spawned on purpose, which the daemon
records when that spawn's agent reports its start, so a fleet restore never changes it. An MCP spawn
without an agent ignores that value and runs Claude Code.

The target step follows the same rule: it lists only the targets that can run the chosen source, and
takes the only one without a picker ([targets](../execution/targets.md)).

The agent listing holds what a caller needs to know about each agent: its kind, whether its binary
is installed, whether it takes its credential from impd's broker, the targets a spawn of it can
start on, and one flag each for spawning, transcript reads, messages, attaching, screen reads and
input. Only a target whose provider runs sessions on the daemon's machine needs the binary on that
machine. A remote target, such as an imp, runs the agent inside its guest, so the daemon accepts a
spawn there whether or not the binary resolves on the daemon's machine. The kind is an open string,
so a caller accepts a kind it has not seen. The listing never holds an environment value, a
credential, a helper command or a base URL.

## Spawn options

A spawn can set a model and a reasoning effort, and the daemon checks each against the options the
agent listing advertises for that agent, so a spawn accepts exactly what the listing shows. An
option the agent's CLI has no flag for is unsupported, and the daemon refuses a spawn that sets it
rather than dropping the value, so a caller never believes a model was applied when it was not. A
gateway agent marks its effort as unverified, since the backend behind the CLI may ignore it. Codex
documents its effort levels per model with no closed list, so atc passes Codex no effort.

Each value reaches the CLI as its own argument, never through a shell, and replaces any model or
effort in the entry's configured arguments for that spawn alone. The fleet row stores both values,
so a restore, an adopt and a headless turn run the session with the model it started with, and a
session spawned without them keeps the configured behaviour.

A Claude or gateway spawn can also name plugin folders, which Claude Code loads for that session
alone through one `--plugin-dir` each, after atc's own mod and after the folders the entry's config
sets. A spawn's folders add to the config's folders and never replace them. The daemon expands a
leading `~` to its user's home and normalizes each path, so a folder named twice loads once. It
refuses the spawn, naming the path, when any path of either list is not a folder on its machine. It
refuses any plugin folder on a target that runs the agent on another machine, because it cannot see
that machine's paths, so the agent listing leaves remote targets out of the spawn targets of an
agent whose config sets folders. The fleet row stores the spawn's own expanded folders, and the
adapter adds the config's folders at each launch and to the command that resumes the session outside
atc. Each later launch checks both lists again, so a session whose folder has gone never starts
without the plugin. A restore lists such a session as refused, naming the path. An adopt, an eject
or a headless turn is refused before it stops anything, so the session stays as it was.
