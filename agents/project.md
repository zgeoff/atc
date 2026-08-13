# atc

atc is a terminal control tower for Claude Code sessions: a daemon (`atc daemon`) hosts stock
`claude` instances in PTYs, and thin TUI clients drive them over an NDJSON protocol behind a
keyboard-driven session list with hook-driven attention routing. No panes, no tiling, no mouse. See
`docs/architecture/overview.md` for how the pieces fit; the README documents keys and user-facing
behavior.

## Layout

Single package, no workspaces. `src/` holds the app (one primary export or entry concern per file),
`test/` holds the PTY-driven e2e suite, `bin/atc` is the executable shim. `scripts/` holds repo
tooling, not app code.

## Runtime rules

- Bun only. `bun test`, never vitest or jest. `bun <file>`, never node or ts-node.
- PTYs come from `bun-pty`. Never add `node-pty`: its fd-socket plumbing delivers no data events
  under Bun.
- The TUI is hand-rolled ANSI on purpose — no TUI framework until the daemon/screen-model
  architecture lands. Escape sequences are written as `\u001B` escapes, never raw bytes and never
  `\x1b`.
- Everything the hooks and CI run is a root `package.json` script; invoke gates by script name,
  never by re-spelling the underlying command.

## Claude integration contract

- Wrangled sessions are instrumented only via the generated `--settings` file (`writeHookSettings`):
  hooks (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) and a chained
  statusline. Never touch the user's own Claude settings.
- Hook and statusline reporters run inside the wrangled session and must always exit 0 — a broken
  reporter must never break the session it reports on.
- Claude is the naming authority for sessions: `/rename` custom-titles beat user-typed names beat
  auto-summaries.
- State lives in `~/.local/state/atc/`: `atc.db` (SQLite — fleet, hook-event trail, spawn history)
  plus `status.json`, which stays a plain file because statusline reporters read it without speaking
  the protocol. The fleet is rewritten on deliberate kills only, so crashes leave a restorable
  fleet.

## Function naming — project verbs

Project additions to the shared taxonomy (keep in sync with `zgeoff/function-verb` in
`.oxlintrc.json`): `ack`, `adopt`, `answer`, `attach`, `boot`, `copy`, `detach`, `draw`, `jiggle`,
`kill`, `log`, `open`, `quit`, `record`, `refresh`, `restart`, `restore`, `schedule`, `spawn`,
`truncate`, `yank`.

Exempt names (tiny geometry/row helpers and script entrypoints): `cols`, `rows`, `ptyRows`, `out`,
`main`, `boxTop`, `boxDivider`, `boxBottom`, `boxRow`, `dimRow`.

## Comments

- JSDoc is always multi-line, never single-line `/** … */`.
- No history or project state in comments — a comment describes the code as it is, never how it got
  that way or what is planned.
- Comments never name other declarations: renames strand the reference. Describe the behavior
  instead.

## Writing

- All committed prose follows the `docs-writing` skill; run its `check-prose.sh` over touched docs
  before committing.
- Banned words in all prose (fix on sight): `bites`, `CAS`, `ceiling`, `fence`/`fencing`, `floor`,
  `load-bearing`, `seam`, `surface`. One carve-out: `Surface` is the domain term for a session's
  output producer (`PtySurface`, `SdkSurface`) — that sense is legal; the vague filler sense ("API
  surface", "surfaces an error") stays banned.

## Testing

Testing conventions live in the `testing` skill (`.claude/skills/testing/SKILL.md`) — regimes,
harness patterns, assertion discipline. Two rules worth restating here: never spawn the real
`claude` binary in tests (verification against real Claude Code happens manually before merging
changes to the integration contract), and every gate is invoked as a root package script.

## Dependencies

- Exact pins only (bunfig `exact = true`); the 7-day `minimumReleaseAge` gate applies. When the
  latest version is younger than the gate, pin the newest version that passes — don't add exclusions
  for convenience.
- A dependency knip can't see gets its `knip.json` ignore entry in the same PR that introduces it,
  with the reason in the PR description.
