---
name: project-testing
description:
  atc's test harness facts on top of the shared testing skill — the per-run test home, the PTY
  harness that drives the real TUI, the stand-ins for agent CLIs, and socket delivery. Load together
  with the testing skill when designing, writing, or reviewing atc tests.
---

# atc testing

The shared testing skill holds every rule. This skill holds only the facts of atc's own harness that
a test author needs to follow those rules here.

## Where a suite lives

Beside the unit tests in each package's `src/`, two root folders hold the suites that cross
packages.

- `e2e/` holds a suite that drives atc from outside: it starts the CLI, the daemon, or the gateway
  as a process, through `runATC`, `startDaemonProcess`, `startMCPStdio`, `startTUIHarness`, or the
  gateway command. `bun run test` leaves `e2e/` out; the `e2e` lane runs it, as [Lanes](#lanes)
  says.
- `integration/` holds one flow across several packages that runs in the test's own process, with
  per-run fixtures and stand-ins such as `startTestDaemon`, `startStubAgentDaemon`, and
  `createStubExecutionProvider`. A test that starts none of atc's own processes goes here, never in
  `e2e/`. `bun run test` runs it, so it follows every unit test rule, with the default 5 s timeout
  and no raised one.

## The test home

Every test run gets its own home, so no test reads or writes your real config, state, sockets, agent
homes, or git config. Run tests through `bun run test`, adding file paths or flags after it. The
package test scripts start through [`with-test-home.sh`](../../../scripts/with-test-home.sh), which
points `HOME`, the XDG directories, and the agent CLIs' homes at a fresh temporary directory before
Bun starts, records it in `ATC_TEST_HOME`, and drops the variables an enclosing atc session sets. On
exit it kills each process that still holds that `ATC_TEST_HOME`, such as a daemon a test never
stopped, and removes the directory; at start it does the same for each directory whose run a kill
stopped. The [`isolate-home`](../../../packages/test-utils/src/isolate-home.ts) preload stops a bare
`bun test` before any test runs: Bun hands a spawned child the environment it started with, so a
home a preload sets never reaches a test's subprocesses.

- Derive a home path from
  [`resolveHomeDir`](../../../packages/contract/src/light/resolve-home-dir.ts), never
  `os.homedir()`: Bun reads `HOME` for `os.homedir()` once at startup, so a home set after startup
  never moves it.
- Change an environment variable through
  [`updateEnv`](../../../packages/test-utils/src/update-env.ts), never by assigning or deleting
  `process.env` keys. It records the value from before the test's first change, and the isolate-home
  preload puts that value back after the test.
- `bun run test:isolation` runs a gate inside a synthetic home of canary files and fails when the
  gate reads, changes, or adds to them;
  [`check-test-isolation.ts`](../../../scripts/check-test-isolation.ts) owns the check. Run it after
  adding anything that writes generated state. It catches a read through access times, so only on a
  filesystem that updates them, and CI runs it on Linux.

## Agent CLIs

- Never spawn the real `claude` binary in a test. A test drives a stand-in, such as the PTY
  harness's stand-in `claude`. `bun run test:isolation` puts a canary `claude` first on `PATH` and
  fails when a test runs it. One exception: `bun run test:atc-bridge` runs `claude plugin validate`
  and `claude plugin test` on the mod, and neither starts a session.
- The Claude config lock's test runs against `proper-lockfile`, the lock library Claude Code
  bundles, because no test runs Claude itself.

## Lanes

A lane suite runs one real system that the default run cannot reach. Its suffix or folder identifies
that system, and [`bunfig.toml`](../../../bunfig.toml) leaves its files out of `bun run test` by
pattern, so a lane suite never skips itself when the system is missing: it fails.

| Suffix or folder | Real system                                                     | Script       | Test timeout |
| ---------------- | --------------------------------------------------------------- | ------------ | ------------ |
| `.codex`         | the Codex CLI's App Server, at the version `CODEX_VERSION` pins | `test:codex` | 5 s default  |
| `e2e/`           | atc's own CLI, daemon, and gateway, each started as a process   | `test:e2e`   | 15 s         |

`test:e2e` is the `e2e` lane script: it gives each test the e2e lane limit of 15 s, so a test in
`e2e/` takes no timeout of its own. The CI test job passes it every `e2e/` suite except the
`e2e/daemon-*` and `e2e/gateway-*` ones, in random order. The smoke job passes it the `e2e/daemon-*`
suites with `ATC_BIN` set to the compiled binary, and the `e2e/gateway-*` suites with
`ATC_GATEWAY_BIN` set to the compiled gateway. With no `e2e/` test file it runs both of those sets.
`test:e2e` takes a few `bun test` options, such as `-t`, and refuses any other option, a filter, or
a file outside `e2e/`, so it never runs the whole repo. `test:related`, and so the pre-push hook,
leaves both lanes out; the `codex` entry in the `lanes` option of `zgeoff/max-test-timeout` in
`.oxlintrc.json` tells it the `.codex` suffix. On macOS, the smoke job first warms the
`/usr/bin/git` shim, whose slow first run would otherwise land inside a daemon's first spawn.

## Shared workers

Every test script runs its files on shared workers with `--no-isolate`, so each worker keeps one
global scope and one module registry across every file it runs. Shared workers finish the suite
sooner than isolated ones, with no higher memory peak. A file that leaves a timer, a handle, a
global, a mock, or a module's state behind can break a later file in the same worker. The preload's
resets after each test are the contract; when a later file fails from state an earlier one left, fix
the file that leaks, never turn isolation back on. CI runs the suite with `--randomize`, so a leak
that depends on file order fails there rather than waiting for an unlucky order.

Each script takes the worker count from `scripts/read-worker-count.ts`, which zgeoff/tools delivers:
1 worker on a host with less than 4 GiB, and a `TEST_WORKERS` that you set wins.

## The PTY harness

[`startTUIHarness`](../../../packages/test-utils/src/start-tui-harness.ts) runs the real `atc`
client in a `bun-pty` pseudo-terminal inside a fresh home. These patterns each come from a real
failure:

- The stand-in `claude`,
  [`buildStubTUIClaude`](../../../packages/test-utils/src/build-stub-tui-claude.ts), is a bash
  script that reports its hook events through the real reporter over the real socket, so everything
  after that boundary is production code. Its doc comment lists the scenario files in the home that
  change what it reports. Extend a scenario by dropping a file into the home, such as
  `fake-transcript.jsonl` with a `custom-title` line, not by adding flags to the script.
- Call `reset()` on the harness before the action whose output you assert on. The capture
  accumulates from boot, and an absence check against the whole run can pass on text drawn two
  screens earlier.
- Consecutive `pty.write()` calls can coalesce into one input chunk. A control byte followed at once
  by a printable (Ctrl-Space then `n`) can arrive as one buffer and be misread. Sequence dependent
  keys through the harness's `waitFor` on each key's observable effect.
- Pick `waitFor` needles from stable output (session names, box titles, state labels), not from hint
  lines: hint text changes with every keybinding addition.
- Type control bytes and escape sequences through
  [`KEYS`](../../../packages/test-utils/src/keys.ts), never as raw bytes or inline escapes.

## Sockets

- `Bun.socket.write()` returns the number of bytes it accepted and silently drops the rest. Only a
  test at the transport catches a missing drain path: prove delivery by sending a slow reader more
  than one write accepts through the real socket, and assert that nothing was lost.
