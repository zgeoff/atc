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
commitlint on the message. Before a push it runs the format check, the shell lint, the import check,
and the lint and tests for what the branch changes, one job at a time, to bound memory. The shell
lint (`bun run lint:shell`) runs shellcheck and `shfmt -d` over the tracked shell scripts, with
shfmt's settings in `.editorconfig`, and leaves out the skill scripts that are synced from another
repo.

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
removes the directory on exit. For a home that persists across runs, set `HOME` and
`XDG_RUNTIME_DIR` to a directory of your own instead. The agent CLIs read their own config from that
home, so sign in to an agent there before you spawn it.

Run from source, atc loads a `.env` file from its working directory, as Bun does by default. A
release binary never reads one.

## Tests

`bun run test` runs the suite in parallel inside a throwaway home, so no test touches your real
state. The `testing` and `project-testing` skills hold the conventions. No test spawns the real
`claude` binary, except the mod checks below, which start no session.

| Script                        | Runs                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `bun run test:related`        | the tests beside the files you pass, less the pre-push skip list     |
| `bun run test:binary`         | the daemon suite against a compiled binary, with `ATC_BIN` set       |
| `bun run test:gateway-binary` | the gateway suite against a compiled gateway, with `ATC_GATEWAY_BIN` |
| `bun run test:atc-bridge`     | `claude plugin validate` and `claude plugin test` on the mod         |
| `bun run test:isolation`      | the suite in a canary home, failing when a test touches a real home  |
| `bun run test:timings`        | the suite, rewriting the timings that start the slowest files first  |

The pre-push hook runs `bun run test:related` over the files the branch changes. That script leaves
out each test in `scripts/pre-push-test-skips.json` and prints the Linear issue of each one it
leaves out. The list holds tests that fail on a developer host and pass in CI. Each entry holds the
test file, the test's full name, and the Linear issue that tracks the failure, and the loader
refuses an entry without an issue ID. CI runs `bun run test:isolation`, which ignores the list, so
every listed test still runs there. When a test fails on your host and passes in CI, open an issue
and add an entry rather than skipping the hook's test job, and remove the entry when the issue's fix
lands.

`bun run test:related` runs the `e2e/` files in a run of their own with one worker. Each end-to-end
test starts a daemon and its sessions from source, and two workers on a 2-CPU host stretch those
start-ups past the per-test time limit.

`bun run build:binaries` compiles the release binaries into `dist/`, and `bun run build:atc-bridge`
regenerates the mod's embedded copy after a change to `mods/atc-bridge/`. `bun run demo:record`
records `docs/assets/demo.gif` against an isolated daemon, and needs vhs, ttyd, ffmpeg, zoxide and a
signed-in `claude`.

## Checking a change to the agent integration

The tests never run a real agent, so a change to how atc launches or instruments an agent gets a
manual check against the real CLI before it merges: spawn a session of that agent from a source
build in its own home, and check that its state, name, messages and notes reach the session list.
