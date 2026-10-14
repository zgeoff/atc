# Attention hooks (Grok and Codex)

Claude needs no install step: atc instruments each spawned Claude session through a generated
`--settings` file, and your global Claude settings are untouched. Grok and Codex take their
instrumentation from your own agent config, so it is a one-time self-install — atc prints the hooks
and never writes them. The daemon runs the commands in the `hooks` key of config.json on its own
events, and the [events guide](../events.md#daemon-hooks) covers that key.

Install the Grok hook file at `$GROK_HOME/hooks/atc-reporter.json` (`~/.grok` when `GROK_HOME` is
unset):

```sh
mkdir -p ~/.grok/hooks
atc grok-hooks > ~/.grok/hooks/atc-reporter.json
```

`atc grok-hooks` prints the hook entries with the `hook-report` command resolved for this install. A
missing file is a Grok PTY without hook-driven attention.

Codex hooks live in `$CODEX_HOME/hooks.json` (`~/.codex` when `CODEX_HOME` is unset):

1. Run `atc codex-hooks` and merge the printed entries into `$CODEX_HOME/hooks.json`.
2. Open `codex`, review the atc hooks in its hooks list, and approve them once. Codex parses
   untrusted hooks but never runs them.

A Codex entry with `auth` needs neither step on an imp target: atc writes the hooks into the
session's own Codex home ([Codex subscription on imps](./codex-subscription.md)).

The installed hook files print `--agent codex` or `--agent grok` for every entry of that kind. A
second Codex entry, such as `codex-fast`, therefore needs no extra install: the daemon accepts the
lines carrying the kind for the session of every entry of that kind. A Claude entry's generated
settings file prints the entry's id instead.

Sessions you start outside atc report events too; the reporter exits immediately when no atc session
id is present.

## Nested harnesses

A harness you start from inside an atc session, such as `codex exec` run by a Claude session,
inherits that session's `ATC_SESSION_ID` and `ATC_SOCKET`, so its hooks report under the parent
session. Each hook command atc writes or prints carries the agent it reports for
(`hook-report --agent codex`), and the daemon drops a report whose agent differs from the one the
session's agent reports under: the entry id for a Claude entry, and the kind for a Codex or Grok
entry. A dropped report never changes the session's agent session id, last output, or state, and the
reporter exits 0.

A hook command without `--agent`, such as one installed from an older `atc codex-hooks` or
`atc grok-hooks`, reports for the session it runs in. The daemon drops it only in a session whose
own hooks have reported with an agent since the session's terminal started, so a Claude session
drops it. A Codex or Grok session whose own hooks lack the flag accepts every report under it,
nested or not. Run `atc codex-hooks` or `atc grok-hooks` again and replace the installed entries to
give those sessions the same protection.

The agent flag cannot separate a nested harness of the session's own agent, such as `codex exec`
inside a Codex session: both report as `codex`. A nested `claude` reports nothing, because atc's
Claude hooks exist only in the settings file atc passes to the sessions it starts. To keep a nested
harness of the same agent from reporting, start it with `ATC_SESSION_ID` and `ATC_SOCKET` removed
from its environment.
