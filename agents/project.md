# atc

atc is a terminal control tower for coding-agent sessions (Claude Code, Grok Build, and Codex CLI):
a daemon (`atc daemon`) hosts stock agent CLIs in PTYs, and thin TUI clients drive them over an
NDJSON protocol behind a keyboard-driven session list with hook-driven attention routing. No panes,
no tiling, no mouse. See `docs/architecture/overview.md` for how the pieces fit; the README
documents install and keys, and `docs/guides/configuration.md` documents config.

## Layout

Single package, no workspaces. `src/` groups its modules by concern, each still one primary export
per file: `daemon/` owns the fleet and per-session runtime state; `client/` is the TUI and its
connection to the daemon; `agents/` holds the `AgentAdapter` interface and the Claude, Grok, Codex,
and gateway implementations; `store/` is the SQLite state store and its migrations; `protocol/` is
the wire format and the transport it rides; `shared/` holds id types, config, and other utilities
used across the rest of `src/`. `cli.ts` is the CLI entrypoint. A module that exists only to back
one of its subcommands stays beside it at `src/` root, while the `tui` and `daemon` subcommands load
their subsystems from `client/` and `daemon/`. `mcp/` holds the MCP tool definitions and request
handling that `mcp-server.ts` serves, plus the HTTP transport behind `mcp-http-server.ts` and the
better-auth authorization server and its pages. `test/` holds the PTY-driven e2e suite, `bin/atc` is
the executable shim. `mods/` holds the `atc-bridge` Claude Code mod. `scripts/` holds repo tooling,
not app code.

## Runtime rules

- Bun only. `bun test`, never vitest or jest. `bun <file>`, never node or ts-node.
- PTYs come from `bun-pty`. Never add `node-pty`: its fd-socket plumbing delivers no data events
  under Bun.
- The TUI is hand-rolled ANSI on purpose — no TUI framework. Escape sequences are written as
  `\u001B` escapes, never raw bytes and never `\x1b`.
- Everything the hooks and CI run is a root `package.json` script; invoke gates by script name,
  never by re-spelling the underlying command.
- Releases ship compiled binaries (`bun build --compile`) next to the source package. Code that
  needs a file outside the bundle at runtime (a package's native binary, the source tree) checks
  `isCompiledBinary()` and takes the path that works without `node_modules`; the daemon suite runs
  through each binary in CI with `ATC_BIN`, so that branch is tested.

## Agent integration contract

- Everything specific to one agent CLI lives in its adapter behind the `AgentAdapter` interface — a
  new agent CLI is an adapter, not a refactor.
- Claude sessions are instrumented only through two files atc writes to its state directory and
  passes per invocation: the generated `--settings` file (`writeHookSettings`), holding hooks
  (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) and a chained
  statusline, and the `atc-bridge` mod passed as `--plugin-dir`.
- The `atc-bridge` mod's source lives in `mods/atc-bridge/`. `bun run build:atc-bridge` regenerates
  its embedded copy in `src/agents/atc-bridge-files.ts`, which compiled binaries write out. The mods
  API is early access, so CI validates and tests the mod against one pinned Claude Code version.
  Never write into the user's own agent config (Claude, Grok, or any future agent); instrumentation
  an agent cannot take per-invocation is a documented self-install step.
- A Claude-compatible backend is a configured gateway, not a new adapter class per vendor: it gets
  its own agent id, its own generated settings file, and its `ANTHROPIC_BASE_URL` in that file's
  `env` block. The credential never goes in the file — a helper command supplies it.
- Grok attention is a user-installed hook file at `$GROK_HOME/hooks/atc-reporter.json`. atc prints
  that file (`atc grok-hooks`) and never writes into the user's Grok config.
- Codex attention is user-installed hook entries in `$CODEX_HOME/hooks.json`, printed by
  `atc codex-hooks` and trusted once in the Codex TUI — Codex parses untrusted hooks but never runs
  them.
- Hook and statusline reporters run inside the wrangled session and must always exit 0 — a broken
  reporter must never break the session it reports on.
- The agent is the naming authority for sessions: `/rename` custom-titles beat user-typed names beat
  auto-summaries.
- A spawn through `atc mcp` from inside a session makes a sub-session of the caller: listed under
  it, pinned and killed with it, one level deep. The MCP server reads the caller from
  `ATC_SESSION_ID`; `detached: true` opts out.
- State lives in `~/.local/state/atc/`: `atc.db` (SQLite — fleet, hook-event trail, spawn history)
  plus `status.json`, which stays a plain file because statusline reporters read it without speaking
  the protocol. `mcp-auth.db` holds the OAuth state of `atc mcp --http`; only that process,
  `atc clients`, and `atc grants` open it, never the daemon. `daemon.lock` admits one daemon per
  state directory, and `daemon.json` holds its pid and socket paths for clients whose environment
  computes other socket paths. The fleet is rewritten on deliberate kills only, so crashes leave a
  restorable fleet; killed sessions persist as exited entries until a second kill removes them,
  except on a target that can destroy its host, where only a confirmed `session.forget` removes one.

## Function naming — project verbs

Project additions to the shared taxonomy (keep in sync with `zgeoff/function-verb` in
`.oxlintrc.json`): `ack`, `adopt`, `answer`, `attach`, `boot`, `copy`, `destroy`, `detach`,
`dispose`, `draw`, `jiggle`, `kill`, `log`, `materialize`, `mint`, `open`, `quit`, `reconcile`,
`record`, `refresh`, `restart`, `restore`, `revoke`, `sanitize`, `schedule`, `spawn`, `suspend`,
`transfer`, `truncate`, `yank`.

`destroy` deletes an execution host and everything on it, which nothing brings back (`destroyHost`),
as opposed to `remove`, which deletes one record or file.

`dispose` releases every resource an object holds in one call (`SessionRuntime.dispose`), and is
safe to call more than once.

`materialize` builds a resource on an execution target from a source held elsewhere, through the
target's provider operations, and checks the result before it counts as ready
(`materializeWorkspace`).

`mint` generates a new id that atc itself is the sole authority for (`mintSessionID`), as opposed to
`to<Brand>`, which trusts an id that arrived from outside atc.

`reconcile` settles stored state that a stopped daemon left mid-change against the evidence the
change leaves behind (`reconcileIdempotencyKeys`).

`revoke` withdraws a credential atc issued so it no longer authorizes anything (`revokeGrant`), as
opposed to `remove`, which deletes a resource outright.

`sanitize` strips a resource of credentials and executable configuration in place and checks that
none remain (`sanitizeWorkspaceClone`), as opposed to `update`, which makes no promise about what is
left.

`suspend` puts an execution host to sleep with its processes kept inside it, so a later wake finds
them as they were (`suspendHost`), as opposed to `kill`, which ends a process.

`transfer` moves content into an execution provider's host (`transferArchive`), as opposed to
`write`, which persists to the daemon's own filesystem.

Exempt names (tiny geometry/row helpers and script entrypoints): `cols`, `rows`, `ptyRows`, `out`,
`main`, `boxTop`, `boxDivider`, `boxBottom`, `boxRow`, `dimRow`.

`init`, `acquireConnection`, `beginTransaction`, `commitTransaction`, `rollbackTransaction`, and
`releaseConnection` are also exempt: kysely's `Driver` interface fixes these method names, so the
state store's driver implements them under the names the library requires.

## Comments

- JSDoc is always multi-line, never single-line `/** … */`.
- No history or project state in comments — a comment describes the code as it is, never how it got
  that way or what is planned.
- Comments never name other declarations: renames strand the reference. Describe the behavior
  instead.

## Writing

- All committed prose follows the `docs-writing` skill; run its `check-prose.sh` over touched docs
  before committing.
- Banned words in all prose (fix on sight): `anchor`/`anchors on` (the data-modelling metaphor — a
  link anchor like `#section-heading` is a different word and stays), `bites`, `CAS`, `ceiling`,
  `fence`/`fencing`, `floor`, `load-bearing`, `seam`, `surface`. One carve-out: `Surface` is the
  domain term for a session's output producer — that sense is legal; the vague filler sense ("API
  surface", "surfaces an error") stays banned.
- A data artifact never speaks: a row, key, id, field, or endpoint does not `name`, `say`, `tell`,
  `answer`, or `know` — it holds, includes, returns, or matches. Three senses of `name` stay: the
  imperative to the reader, assigning a name ("the `-o` flag names the output file"), and an error
  or doc that mentions something in its text.

## Testing

Testing conventions live in the shared `testing` skill and in atc's `project-testing` skill (the PTY
harness, the fake `claude`, and the daemon-phase rules); load both. Two rules worth restating here:
never spawn the real `claude` binary in tests (verification against real Claude Code happens
manually before merging changes to the integration contract), and every gate is invoked as a root
package script. One exception to the first rule: `test:atc-bridge` runs `claude plugin validate` and
`claude plugin test` on the mod, and neither starts a session.

## Dependencies

- Exact pins only (bunfig `exact = true`); the 7-day `minimumReleaseAge` gate applies. When the
  latest version is younger than the gate, pin the newest version that passes — don't add exclusions
  for convenience.
- A dependency knip can't see gets its `knip.json` ignore entry in the same PR that introduces it,
  with the reason in the PR description.
