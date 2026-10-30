# Development

atc is a Bun workspace with the app in `packages/app`. The repo's [AGENTS.md](../../AGENTS.md) holds
the layout and the runtime rules, and this runbook covers setting up a checkout and running it.

## Setting up

1. Install the Bun version in `.bun-version`, gitleaks, which the pre-commit hook runs, and
   shellcheck and shfmt, which the pre-push hook runs.
2. Install the dependencies. The `prepare` script installs the lefthook git hooks:

   ```bash
   bun install
   ```

3. Run the checks:

   ```bash
   bun run typecheck
   bun run lint
   bun run test
   ```

   `bun run lint:full` runs the type-aware lint, and runs in CI only.

lefthook runs oxlint, oxfmt, format-codemod and gitleaks on the staged files before a commit, and
commitlint on the message. Before a push it runs atc's own checks, such as the guest script check
and the import check, and then the
[pre-push baseline](https://github.com/zgeoff/tools/blob/main/docs/architecture/pre-push-baseline.md)
that zgeoff/tools delivers: the format check, the type check, and the lint, shell lint and unit
tests for what the branch changes. The hook runs one job at a time, each under a memory cap set to
the host's memory, and prints each job's peak memory. A push that only deletes remote branches, such
as `git push origin --delete <branch>`, carries no content, so the hook skips atc's own checks and
the tests. CI runs the shell lint (`bun run lint:shell`) over every tracked shell script, with
shfmt's settings in `.editorconfig`, and leaves out the skill scripts that are synced from another
repo. The guest script check (`bun run check:guest-scripts`) runs shellcheck over the shell scripts
that atc holds as strings, which the shell lint cannot see.

A squash merge makes the PR title the commit subject, so the `PR Title` workflow runs commitlint on
the title each time a PR opens, changes its title, or takes a push.

## Running from source

A source build must never talk to the daemon your installed release runs, because the two can speak
different protocol versions, and every live client and service unit starts the installed binary.
Give a source build a home of its own, which moves its state directory, config and sockets with it:

```bash
bash scripts/with-test-home.sh bun packages/app/src/cli.ts
```

`with-test-home.sh` points `HOME`, `XDG_RUNTIME_DIR` and the agent homes at a fresh temporary
directory, strips the enclosing atc session's variables so nothing reports to a live daemon, and
removes the directory on exit, after it kills each process still running in it. A run that a kill
stopped leaves its directory and processes behind, and the next run removes them. For a home that
persists across runs, set `HOME` and `XDG_RUNTIME_DIR` to a directory of your own instead. The agent
CLIs read their own config from that home, so sign in to an agent there before you spawn it.

Run from source, atc loads a `.env` file from its working directory, as Bun does by default. A
release binary never reads one.

## Tests

`bun run test` runs the suite in parallel inside a throwaway home, so no test touches your real
state. The `testing` and `project-testing` skills hold the conventions. No test spawns the real
`claude` binary, except the mod checks below, which start no session.

| Script                                   | Runs                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `bun run test:related`                   | the unit tests beside the files you pass                             |
| `bun run test:e2e e2e/tui-*.test.ts`     | the e2e suites you pass, under the e2e lane limit of 15 s            |
| `bun run test:e2e e2e/daemon-*.test.ts`  | the daemon suite against a compiled binary, with `ATC_BIN` set       |
| `bun run test:e2e e2e/gateway-*.test.ts` | the gateway suite against a compiled gateway, with `ATC_GATEWAY_BIN` |
| `bun run test:atc-bridge`                | `claude plugin validate` and `claude plugin test` on the mod         |
| `bun run test:isolation`                 | the suite in a canary home, failing when a test touches a real home  |
| `bun run test:timings`                   | the suite, rewriting the timings that start the slowest files first  |

Each test script takes its worker count from the
[worker helper](https://github.com/zgeoff/tools/blob/main/docs/architecture/memory-caps.md#the-worker-count):
a small host runs 1 worker, and a `TEST_WORKERS` that you set wins. The pre-push hook runs
`bun run test:related` over the files the branch changes, and leaves `e2e/` and the codex lane to
CI.

`bun run build:binaries` compiles the release binaries into `dist/`, and `bun run build:atc-bridge`
regenerates the mod's embedded copy after a change to `mods/atc-bridge/`. `bun run demo:record`
records `docs/assets/demo.gif` against an isolated daemon, and needs vhs, ttyd, ffmpeg, zoxide and a
signed-in `claude`.

## Checking a change to the agent integration

The tests never run a real agent, so a change to how atc launches or instruments an agent gets a
manual check against the real CLI before it merges: spawn a session of that agent from a source
build in its own home, and check that its state, name, messages and notes reach the session list.
