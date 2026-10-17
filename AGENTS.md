# Agent Guidelines

atc is a terminal control tower for coding-agent sessions (Claude Code, Grok Build, and Codex CLI):
a daemon (`atc daemon`) hosts stock agent CLIs in PTYs, and thin TUI clients drive them over an
NDJSON protocol behind a keyboard-driven session list with hook-driven attention routing. No panes,
no tiling, no mouse. `docs/README.md` indexes the docs: `docs/architecture/overview.md` covers how
the pieces fit, `docs/guides/using-atc.md` the keys, `docs/guides/configuration.md` the config, and
`docs/runbooks/development.md` running a checkout.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill                | Load before                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| `code-style`         | writing, reviewing, or renaming any TypeScript — the function-verb taxonomy      |
| `project-code-style` | the same, beside `code-style` — atc's own verbs, exempt names, and comment rules |
| `testing`            | designing, writing, or reviewing tests                                           |
| `project-testing`    | the same, beside `testing` — atc's test home and PTY harness                     |
| `docs-writing`       | writing or editing any committed prose: `docs/`, READMEs, this file, skills      |
| `tool-contract`      | adding, renaming, or redescribing an `atc mcp` tool or an atc-bridge tool        |

## Layout

A Bun workspace. The root package is private and holds the repo tooling. Every workspace package is
private, sits under `packages/`, and is named `@atc/<name>`; `scripts/package-rules.ts` lists them
and the internal packages each may depend on.

- `packages/app` holds the app: both entrypoints and every module they wire together. `cli.ts` is
  the CLI entrypoint. `gateway.ts` is the entrypoint of the separate `atc-gateway` binary, which
  never starts a daemon.
- The app's `src/` groups modules by concern: `client/` (the TUI and its connection), `agents/`
  (adapters from the config's agent map), `sources/` (the built-in discovery sources), `plugins/`
  (the shipped plugin lists and the execution providers built from them), `mcp/` (the MCP tools, the
  HTTP transport, and the auth server), `federation/` (the gateway's daemon registry), `shared/`,
  and `test-utils/` (helpers that start or drive the daemon). A module that exists only to back one
  subcommand stays beside it at the `src/` root.
- `packages/daemon` holds the fleet and per-session runtime state. It loads no plugin: the app
  passes in its execution targets and agent adapters. Its `src/` groups modules in folders
  (`sessions/`, `fleet/`, `auth/`, `transport/`, `sources/`, `workspace/`), and the folder rules in
  `scripts/package-rules.ts` limit which sibling folders each one imports.
- `packages/harnesses/`, `packages/execution/`, and `packages/sources/` hold one plugin package
  each; the app wires them together. `packages/plugin-api` holds the contracts a plugin implements,
  among them the `AgentAdapter` interface.
- `packages/test-utils` holds the generic test helpers, stand-ins, factories, and the test preload.
- `e2e/` holds the end-to-end suites, `mods/` the `atc-bridge` Claude Code mod, `bin/atc` the dev
  shim that runs the CLI from a checkout, and `scripts/` the repo tooling.

### Entry points

An entry point is the `index.ts` at the root of a folder, and the rest of the folder stays internal.
Most packages have one entry, `.`, and a package with a `src/testing/` folder adds a `./testing`
entry that `.` never re-exports. A package gets a second entry only for a reason, never one entry
per file. The usual reason is start-up time: a hook or statusline command starts once per event
inside a session, so a package whose `.` entry builds Zod schemas, the protocol contract, or the
store keeps what a reporter needs in a light entry that `.` re-exports. A module never imports its
own package by name; imports inside a package stay relative. The preload modules that `bunfig.toml`
loads by path stay out of `@atc/test-utils`'s entry, because they run top-level code.

## Commands

- `bun run typecheck`, `bun run lint`, and `bun run test` are the local checks.
  `bun run test:related <files>` runs the tests beside the files you pass.
- `bun run lint:full` adds the type-aware pass and the type check. It runs in CI only: never run it
  locally.
- `bun run build:import-rules` regenerates `.oxlintrc.imports.json` after a change to
  `scripts/package-rules.ts` or `scripts/package-confinement.ts`.
- `bun run build:atc-bridge` regenerates the mod's embedded copy after a change to
  `mods/atc-bridge/`.
- lefthook runs the light checks before a commit and a push. Defer larger checks to CI, as the
  environment you work in may have conservative memory limits.

## Checks

Each gate is a root `package.json` script; invoke it by script name, never by re-spelling the
command. A failure prints its own reason, and the rules live where each bullet points.

- `bun run check:imports`: the import graph inside the app's `src/` — cycles and the directory rows
  in `scripts/check-imports.ts`.
- `bun run lint` (oxlint): the per-import package rules in `.oxlintrc.imports.json`, generated from
  `scripts/package-rules.ts` and `scripts/package-confinement.ts`, plus `.oxlintrc.json`.
- `bun run lint:mods`: the confinement rules and the `require()` and `import()`-type bans for
  `mods/`, in `.oxlintrc.mods.json`.
- `bun run check:manifests`: each package's manifest, `exports` map, and import specifiers, in
  `scripts/check-manifests.ts`.
- `bun run check:reach`: what the gateway entry, the reporters, and `cli.ts` may reach, in
  `scripts/check-reach.ts`.
- `bun run check:bundle`: the execution providers the atc bundle carries, in
  `scripts/check-bundle.ts`.
- `bun run check:disable-baseline`: the count of directives that switch off an import rule, against
  `scripts/disable-baseline.json`.
- `bun run deadcode`: knip, configured in `knip.json`.
- `bun run test:isolation`: the suite in a canary home, failing when a test touches a real home.

## Operations

- Perform all work on a branch in a git worktree under `.worktrees/` (e.g.
  `git worktree add .worktrees/<branch> -b <branch>`) — never commit directly on `main`.
- Commit messages and PR titles are [Conventional Commits](https://www.conventionalcommits.org/) in
  the imperative mood. A squash merge makes the PR title the commit subject, so
  `feat(#412): add the retry budget` is a title; `add the retry budget` is not.
- Open PRs against `main` using the PR template (`.github/PULL_REQUEST_TEMPLATE.md`). Descriptions
  are condensed: lead paragraph ≤2 sentences, one-line bullets, ≤150 words — write the short version
  first, don't draft long and trim.
- After pushing, link the PR URL in your response.
- A PR is ready only when its checks are green: watch CI (`gh pr checks <n> --watch`) after opening
  or updating, and report a failure with what you're doing about it.

## Dependencies

- Pin exact versions — no `^`/`~` ranges. `bun add` saves exact; the rule applies to hand-written
  edits.
- The 7-day `minimumReleaseAge` gate applies. When the latest version is younger than the gate, pin
  the newest version that passes — don't add exclusions for convenience.
- A dependency knip can't see gets its `knip.json` ignore entry in the same PR that introduces it,
  with the reason in the PR description. `knip.json` takes no comments, so the reasons for its two
  ignores live here: `.oxlintrc.json` extends `@zgeoff/oxlint-config` through a `node_modules` path,
  and that config loads `@stylistic/eslint-plugin` by name as a JS plugin.

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

## Runtime rules

- Bun only. `bun test`, never vitest or jest. `bun <file>`, never node or ts-node.
- PTYs come from `bun-pty`. Never add `node-pty`: its fd-socket plumbing delivers no data events
  under Bun.
- The TUI is hand-rolled ANSI on purpose — no TUI framework. Write escape sequences as `\u001B`
  escapes, never raw bytes.
- Releases ship only compiled binaries (`bun build --compile`). Code that needs a file outside the
  bundle at runtime (a package's native binary, the source tree) checks `isCompiledBinary()` and
  takes the path that works without `node_modules`; the daemon suite runs through each binary in CI
  with `ATC_BIN`, so that branch is tested.
- The live install on a machine runs an installed release: the global MCP server entry, every
  service unit, and every long-running `atc` process start `~/.local/bin/atc` (or the release's
  install path), never `bun packages/app/src/cli.ts` from a checkout, so a pull or branch switch in
  a checkout never changes the protocol a live client speaks. Run source builds against a daemon of
  their own, in a state directory of their own.

## Agent integration contract

[Agent integration](docs/architecture/agents/agent-integration.md) describes how each agent is
instrumented. These rules hold for any change to it:

- Everything specific to one agent CLI lives in its adapter behind the `AgentAdapter` interface — a
  new agent CLI is an adapter, not a refactor.
- Claude sessions are instrumented only through files atc writes and passes per invocation: the
  generated `--settings` file, the `atc-bridge` mod passed as `--plugin-dir`, and the per-session
  folders the doc lists.
- Never write into the user's own agent config (Claude, Grok, or any future agent); instrumentation
  an agent cannot take per invocation is a documented self-install step (`atc grok-hooks`,
  `atc codex-hooks`). One exception: a local launch that opts into clone trust adds one folder-trust
  entry for its verified clone root to the user's Claude config, under Claude's own lock, since
  Claude takes trust no other way.
- The config's `agents` map is the registry: one adapter per entry, keyed by the entry's id. A
  Claude-compatible backend is an entry with a `baseURL`, not a new adapter class per vendor, and
  its credential never goes in the generated file — a helper command supplies it.
- Hook and statusline reporters run inside the wrangled session and must always exit 0 — a broken
  reporter must never break the session it reports on.
- The agent is the naming authority for sessions: `/rename` custom-titles beat user-typed names beat
  auto-summaries.
- The mods API is early access, so CI validates and tests the mod against one pinned Claude Code
  version.

## State

State lives in `~/.local/state/atc/`; the [architecture overview](docs/architecture/overview.md)
covers its stores. These rules hold for any change to it:

- `status.json` stays a plain file, because statusline reporters read it without speaking the
  protocol.
- Only `atc mcp --http`, `atc clients`, `atc grants`, and `atc passkeys` open `mcp-auth.db`, never
  the daemon.
- A session death the owner never asked for rewrites nothing in the fleet, so a crash leaves a
  restorable fleet. [Fleet and restore](docs/architecture/daemon/fleet-and-restore.md) holds the
  rules for each rewrite.

## MCP and bridge tools

The `tool-contract` skill holds the rules for every `atc mcp` tool and every atc-bridge tool; load
it before you add, rename, or redescribe one. An `atc mcp` tool is named `atc_<noun>_<verb>`, where
the noun is the channel it reaches. Check each claim in a description against the code or a live run
on a dev daemon, never from memory.

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

- Never spawn the real `claude` binary in tests. Verification against real Claude Code happens
  manually before merging a change to the agent integration contract. One exception:
  `test:atc-bridge` runs `claude plugin validate` and `claude plugin test` on the mod, and neither
  starts a session.
- The Claude config lock's test runs against `proper-lockfile`, the lock library Claude Code
  bundles, not against Claude itself. So the manual check before an integration-contract merge also
  confirms that the pinned Claude Code version refreshes a held lock well inside the age at which
  atc takes a lock over as stale.
- A test helper that runs atc or atc-gateway takes the source entry that `scripts/with-test-home.sh`
  exports, so it does not depend on where the app sits.
