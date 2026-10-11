# Agent Guidelines

atc is a terminal control tower for coding-agent sessions (Claude Code, Grok Build, and Codex CLI):
a daemon (`atc daemon`) hosts stock agent CLIs in PTYs, and thin TUI clients drive them over an
NDJSON protocol behind a keyboard-driven session list with hook-driven attention routing. No panes,
no tiling, no mouse. `docs/README.md` indexes the docs: `docs/architecture/overview.md` covers how
the pieces fit, `docs/guides/using-atc.md` the keys, `docs/guides/configuration.md` the config, and
`docs/runbooks/development.md` running a checkout.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill             | Load before                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `code-style`      | writing, reviewing, or renaming any TypeScript — the function-verb taxonomy and comment rules |
| `testing`         | designing, writing, or reviewing tests                                                        |
| `project-testing` | the same, beside `testing` — atc's test home and PTY harness                                  |
| `docs-writing`    | writing or editing any committed prose: `docs/`, READMEs, this file, skills                   |
| `tool-contract`   | adding, renaming, or redescribing an `atc mcp` tool or an atc-bridge tool                     |

## Operations

- Perform all work on a branch in a git worktree under `.worktrees/` (e.g.
  `git worktree add .worktrees/<branch> -b <branch>`) — never commit directly on `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages.
- A squash merge makes the PR title the commit subject, so a PR title is a Conventional Commit too.
  `feat(#412): add the retry budget` is a title; `add the retry budget` is not.
- Commit subjects and PR titles use the imperative mood ("add X", never "added X" or a bare noun
  phrase).
- Open PRs against `main` using the PR template (`.github/PULL_REQUEST_TEMPLATE.md`). Descriptions
  are condensed: lead paragraph ≤2 sentences, one-line bullets, ≤150 words — write the short version
  first, don't draft long and trim.
- After pushing, link the PR URL in your response.
- A PR is ready only when its checks are green: watch CI (`gh pr checks <n> --watch`) after opening
  or updating, and report a failure with what you're doing about it.
- Light linting, formatting, and other checks run via lefthook's pre-commit and pre-push hooks.
  Defer to CI for larger checks, as the environment you're operating in may have conservative memory
  constraints.
- `bun run lint` is plain oxlint. `bun run lint:full` adds the type-aware pass and the type check,
  and is CI-only: never run it locally.

## Dependencies

- Pin exact versions — no `^`/`~` ranges. (`bun add` saves exact automatically via `exact = true` in
  bunfig.toml — the rule applies to hand-written edits.) The 7-day `minimumReleaseAge` gate applies.
  When the latest version is younger than the gate, pin the newest version that passes — don't add
  exclusions for convenience.
- A dependency knip can't see gets its `knip.json` ignore entry in the same PR that introduces it,
  with the reason in the PR description.

## Review bots

CodeRabbit reviews every PR. Its shared config lives in the zgeoff/coderabbit repo, and a repo-root
`.coderabbit.yaml` with `inheritance: true` layers repo-specific settings on top. CodeRabbit reads
this file as its guidelines. A review bot added later is named here with its config, and these rules
cover it too.

- A PR is ready only after every bot review is read and every finding is answered: a fixed finding's
  reply cites the commit that fixed it; a declined finding's reply states the reason — when a
  finding contradicts this file, this file wins and the reply names the rule. Reviews land within a
  few minutes of opening; read them with `gh pr view <n> --comments` and
  `gh api repos/<owner>/<repo>/pulls/<n>/comments`. A finding outside the diff arrives in the review
  body, not as a thread, so its answer is a PR comment.
- Resolve a thread once its reply is posted, fixed and declined alike (GraphQL
  `resolveReviewThread`). A finding the agent cannot confidently judge is escalation, not
  disposition: reply saying so and leave the thread open for a human.
- Never teach a bot through chat (`@coderabbitai` learnings and the like) — a correction to bot
  behaviour is an edit to its config, reviewed in a PR.
- Bots review a PR once, at open; an agent invokes a re-review only when asked. The exception is a
  PR that got no review at all, such as one opened before the bot was installed: request it once
  with that bot's documented trigger, such as `@coderabbitai review` for CodeRabbit.

## Layout

Single package, no workspaces. `src/` groups its modules by concern, each still one primary export
per file: `daemon/` owns the fleet and per-session runtime state; `client/` is the TUI and its
connection to the daemon; `agents/` holds the `AgentAdapter` interface and the Claude, Grok, Codex,
and gateway implementations; `store/` is the SQLite state store and its migrations; `workspace/`
resolves a spawn's workspace source and clones, sanitizes, and archives it; `sources/` holds the
spawn picker's discovery sources, the directories, GitHub, and git URL sources the daemon offers;
`protocol/` is the wire format, the transport it rides, and the types both ends of it share;
`shared/` holds id types, config, and other utilities used across the rest of `src/`. `cli.ts` is
the CLI entrypoint, and `gateway.ts` is the entrypoint of the separate `atc-gateway` binary, which
must never reach `daemon/`, `agents/`, or any module that starts a daemon. A module that exists only
to back one of its subcommands stays beside it at `src/` root, while the `tui` and `daemon`
subcommands load their subsystems from `client/` and `daemon/`. `bun run check:imports` fails on an
import cycle and on an import a directory's rule forbids; the rules live in
`scripts/check-imports.ts`. `mcp/` holds the MCP tool definitions and request handling that
`mcp-server.ts` serves, plus the HTTP transport behind `mcp-http-server.ts` and the better-auth
authorization server and its pages. `federation/` holds the gateway's daemon registry, per-daemon
callers, and id and cursor rewriting, and imports only `shared/` and `protocol/`. `test-utils/`
holds the shared test helpers, stand-ins, and factories, each with its test beside it, and no
production module imports it. `e2e/` at the repo root holds the end-to-end suites that run the whole
program, `bin/atc` is the executable shim. `mods/` holds the `atc-bridge` Claude Code mod.
`scripts/` holds repo tooling, not app code.

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
- The live install on a machine runs an installed release: the global MCP server entry, every
  service unit, and every long-running `atc` process start `~/.local/bin/atc` (or the release's
  install path), never `bun src/cli.ts` from a checkout. A pull or branch switch in a checkout then
  never changes the protocol a live client speaks. Run source builds against a daemon of their own,
  in a state directory of their own.

## Agent integration contract

- Everything specific to one agent CLI lives in its adapter behind the `AgentAdapter` interface — a
  new agent CLI is an adapter, not a refactor.
- Claude sessions are instrumented only through files atc writes and passes per invocation: the
  generated `--settings` file (`writeHookSettings`), holding hooks (`SessionStart`, `Notification`,
  `Stop`, `UserPromptSubmit`, `SessionEnd`) and a chained statusline, and the `atc-bridge` mod
  passed as `--plugin-dir`. A session that signs in through impd's broker on an imp also gets a
  Claude config folder of its own in its guest folder, passed as `CLAUDE_CONFIG_DIR` and seeded with
  onboarding state, the seen mark of the one-time offer to block reads outside the working
  directories, and clone trust. Every Claude session gets a scratch folder of its own, passed as
  `--add-dir` and as `TMPDIR`. Stock Claude's folder also takes an allow-listed copy of the daemon
  host's own Claude config at each launch; atc reads that config and never writes it.
- The `atc-bridge` mod's source lives in `mods/atc-bridge/`. `bun run build:atc-bridge` regenerates
  its embedded copy in `src/agents/atc-bridge-files.ts`, which compiled binaries write out. The mods
  API is early access, so CI validates and tests the mod against one pinned Claude Code version.
  Never write into the user's own agent config (Claude, Grok, or any future agent); instrumentation
  an agent cannot take per-invocation is a documented self-install step. One exception: a local
  launch that opts into clone trust adds one folder-trust entry for its verified clone root to the
  user's Claude config, under Claude's own lock, since Claude takes trust no other way.
- The config's `agents` map is the registry: one adapter per entry, keyed by the entry's id, so
  several entries of one kind coexist. A Claude-compatible backend is an entry with a `baseURL`, not
  a new adapter class per vendor: it gets its own agent id, its own generated settings file, and its
  `ANTHROPIC_BASE_URL` in that file's `env` block. The credential never goes in the file — a helper
  command supplies it.
- Grok attention is a user-installed hook file at `$GROK_HOME/hooks/atc-reporter.json`. atc prints
  that file (`atc grok-hooks`) and never writes into the user's Grok config.
- Codex attention is user-installed hook entries in `$CODEX_HOME/hooks.json`, printed by
  `atc codex-hooks` and trusted once in the Codex TUI — Codex parses untrusted hooks but never runs
  them. A Codex session that signs in through impd's broker on an imp instead gets a Codex home of
  its own in its guest folder, passed as `CODEX_HOME`, with a sign-in file that holds no credential,
  a config, and those hook entries, which it runs with `--dangerously-bypass-hook-trust`.
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

## MCP and bridge tools

The `tool-contract` skill holds the rules for every `atc mcp` tool and every atc-bridge tool, each
with an example from the current tools; load it before you add, rename, or redescribe one. An agent
picks a tool from its name and description alone, so the rules start there:

- Name an `atc mcp` tool `atc_<noun>_<verb>`, where the noun is the channel it reaches
  (`atc_terminal_type`, `atc_message_send`); a bridge tool takes a single verb or noun inside the
  `mcp__atc-bridge__` namespace (`note`). Never imply a capability the tool lacks.
- Write the description in order: what the tool does and on which channel, when to use another tool
  instead, what the result means, then the limits.
- Say only what a result shows (written, queued, delivered, answered), and name the read that shows
  more.
- State what the tool cannot do, what it destroys, its defaults, and what a retry does.
- Put field meanings in output-schema property descriptions, never an `enum`, and keep one sentence
  in the description that states where a partial or failing result is flagged.
- State a known bug without an issue reference, and remove the clause with the fix.
- Check each claim against the code or a live run on a dev daemon, never from memory.
- Rename with a breaking change and no alias; an old daemon gets `daemon_outdated`.
- Use one word per concept across tools, events, CLI, and docs: note, never report.

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

Testing conventions live in the shared `testing` skill and in atc's `project-testing` skill (the
test home and the PTY harness); load both. Two rules worth restating here: never spawn the real
`claude` binary in tests (verification against real Claude Code happens manually before merging
changes to the integration contract), and every gate is invoked as a root package script. One
exception to the first rule: `test:atc-bridge` runs `claude plugin validate` and
`claude plugin test` on the mod, and neither starts a session.
