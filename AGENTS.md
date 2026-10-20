# Agent Guidelines

atc is a terminal control tower for coding-agent sessions (Claude Code, Grok Build, and Codex CLI):
a daemon (`atc daemon`) hosts stock agent CLIs in PTYs, and thin TUI clients drive them over oRPC
peer messages, one JSON message per line. `docs/README.md` indexes the docs, and
`docs/architecture/overview.md` covers how the pieces fit.

## Required reading

The rules a task needs are not repeated here. Load the skill for the work before starting it.

| Skill                | Load before                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `code-style`         | writing, reviewing, or renaming any TypeScript — the role table of function verbs and the comment rule |
| `project-code-style` | the same, beside `code-style` — the place for atc's additions to it                                    |
| `testing`            | designing, writing, or reviewing tests                                                                 |
| `project-testing`    | the same, beside `testing` — atc's test home and PTY harness                                           |
| `docs-writing`       | writing or editing any committed prose: `docs/`, READMEs, this file, skills                            |
| `tool-contract`      | adding, renaming, or redescribing an `atc mcp` tool or an atc-bridge tool                              |

## Repo structure

atc is one Bun workspace. The root package holds the repo tooling.

```text
packages/
  app/           the atc and atc-gateway entrypoints and the modules they wire together; a module
                 that backs one subcommand sits beside it at the src/ root
  daemon/        the session fleet, its runtime state, and the protocol server; it loads no plugin,
                 because the app passes in its execution targets and agent adapters
  plugin-api/    the contracts a plugin implements, among them the AgentAdapter interface
  harnesses/     one package per agent CLI: claude, codex, grok
  execution/     one package per execution provider: local, imp
  sources/       one package per discovery source: dirs, git, github
  config/ core/ lifecycle/ protocol/ store/
                 the shared layers; each package.json describes its own
  test-utils/    the generic test helpers, stand-ins, factories, and the test preload
e2e/             end-to-end suites
mods/atc-bridge/ the Claude Code mod
bin/atc          the dev shim that runs the CLI from a checkout
scripts/         the repo tooling and the checks
docs/
  architecture/  what is built
  guides/        steps a user does
  runbooks/      operator and contributor procedures
```

## Packages

- Every workspace package is private and named `@atc/<name>`. The `zgeoff/import-zones` rule in
  `.oxlintrc.zones.json` gives each package a zone, the internal packages it may depend on, the
  folder rules inside the daemon, and the files that may import each confined external package.
- Give a package a second entry point only for a reason, never one per file. The usual reason is
  start-up time: a hook or statusline reporter starts once per event, so it imports a light entry
  that skips the Zod schemas, the protocol contract, and the store.

## Commands

- `bun run typecheck`, `bun run lint`, and `bun run test` are the local checks.
  `bun run test:related <files>` runs the tests beside the files you pass.
- `bun run lint:full` adds the type-aware pass and the type check. It runs in CI only, so never run
  it locally.
- `bun run build:atc-bridge` regenerates the mod's embedded copy after a change to
  `mods/atc-bridge/`.
- lefthook runs the light checks before a commit and a push. Leave the larger checks to CI, because
  the host may have little memory.

## Checks

Each check is a root `package.json` script. Run it by script name, never by its command. A failure
prints its own reason, and the rules live where each bullet points.

- `bun run check:imports`: the import graph inside the app's `src/`, with the directory rows in
  `scripts/check-imports.ts`.
- `bun run lint`: `.oxlintrc.json`, which takes the package boundaries from `.oxlintrc.zones.json`.
  `e2e/import-zones.test.ts` lints a probe import against each boundary.
- `bun run lint:mods`: the rules for `mods/`, in `.oxlintrc.mods.json`.
- `bun run check:manifests`: each package's manifest, `exports` map, and import specifiers, in
  `scripts/check-manifests.ts`. It also checks each declared workspace dependency against the edges
  in `.oxlintrc.zones.json`, since the lint rule sees only the imports a file holds.
- `bun run check:reach`: what the gateway entry, the reporters, and `cli.ts` may reach, in
  `scripts/check-reach.ts`.
- `bun run check:bundle`: the execution providers the atc bundle carries, in
  `scripts/check-bundle.ts`.
- `bun run check:disable-baseline`: the count of directives that switch off an import rule, against
  `scripts/disable-baseline.json`.
- `bun run check:raw-escapes`: a raw ESC byte in source, which the TUI writes as a `\u001B` escape.
- `bun run check:source-entries`: a test helper that hard-codes a source entry that
  `scripts/with-test-home.sh` exports.
- `bun run deadcode`: knip, configured in `knip.json`.
- `bun run test:isolation`: the suite in a canary home, failing when a test touches a real home.

## Dependencies

- `bunfig.toml` holds new versions back for 7 days. When the latest version is younger, pin the
  newest version that passes, and add no exclusion for convenience.
- A dependency knip cannot see gets its `knip.json` ignore in the PR that adds it, with the reason
  in the PR description. `knip.json` takes no comments, so the reasons for its ignores live here:
  - `@stylistic/eslint-plugin`: `@zgeoff/oxlint-config`, which `.oxlintrc.json` extends, loads it by
    name as a JS plugin.
  - `better-auth` in `packages/test-utils`: the telemetry collector's test loads it inside a spawned
    `bun -e` script.

## Runtime rules

- The TUI is hand-rolled ANSI on purpose, with no TUI framework.
- Releases ship only compiled binaries (`bun build --compile`). Code that needs a file outside the
  bundle at runtime, such as a package's native binary or the source tree, checks
  `isCompiledBinary()` and takes the path that works without `node_modules`. CI runs the daemon
  suite through each binary with `ATC_BIN`, so that branch is tested.
- The live install on a machine runs an installed release. The global MCP server entry, every
  service unit, and every long-running `atc` process start the installed binary, never
  `bun packages/app/src/cli.ts` from a checkout, so a pull or branch switch never changes the
  protocol a live client speaks. Run a source build against a daemon and a state directory of its
  own.

## Agent integration contract

[Agent integration](docs/architecture/agents/agent-integration.md) describes how each agent is
instrumented. These rules hold for any change to it:

- Everything specific to one agent CLI lives in its adapter behind the `AgentAdapter` interface. A
  new agent CLI is an adapter, not a refactor.
- Claude sessions are instrumented only through files atc writes and passes per invocation: the
  generated `--settings` file, the `atc-bridge` mod passed as `--plugin-dir`, and the per-session
  folders the doc lists.
- Never write into the user's own agent config. Instrumentation an agent cannot take per invocation
  is a documented self-install step (`atc grok-hooks`, `atc codex-hooks`). One exception: a local
  launch that opts into clone trust adds one folder-trust entry for its verified clone root to the
  user's Claude config, under Claude's own lock, since Claude takes trust no other way.
- The config's `agents` map is the registry: one adapter per entry, keyed by the entry's id. A
  Claude-compatible backend is an entry with a `baseURL`, not a new adapter class per vendor. A
  helper command supplies its credential, which never goes in the generated file.
- Hook and statusline reporters run inside the wrangled session and always exit 0, so a broken
  reporter never breaks the session it reports on.
- The agent is the naming authority for sessions: `/rename` custom titles beat user-typed names,
  which beat auto-summaries.
- Before you merge a change to this contract, check it by hand against real Claude Code. The check
  also confirms that the pinned Claude Code version refreshes a held config lock well inside the age
  at which atc takes a lock over as stale, because the lock's test runs against `proper-lockfile`
  and not against Claude.

## State

State lives in `~/.local/state/atc/`, and the [architecture overview](docs/architecture/overview.md)
covers its stores.

- `status.json` stays a plain file, because statusline reporters read it without speaking the
  protocol.
- A session death the owner never asked for rewrites nothing in the fleet, so a crash leaves a
  restorable fleet. [Fleet and restore](docs/architecture/daemon/fleet-and-restore.md) holds the
  rules for each rewrite.

## Banned words

`check-prose.sh` greps for most of these, and skips this file because it holds the list.

- `anchor` and `anchors on`, in the data-modelling sense. A link anchor such as `#section-heading`
  is a different word and stays.
- `bites`, `CAS`, `ceiling`, `fence` and `fencing`, `floor`, `load-bearing`, `seam`, `surface`.
