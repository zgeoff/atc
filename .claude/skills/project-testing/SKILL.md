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

## The test home

Every test run gets its own home, so no test reads or writes your real config, state, sockets, agent
homes, or git config. Run tests through `bun run test`, adding file paths or flags after it. The
package test scripts start through [`with-test-home.sh`](../../../scripts/with-test-home.sh), which
points `HOME`, the XDG directories, and the agent CLIs' homes at a fresh temporary directory before
Bun starts, records it in `ATC_TEST_HOME`, and drops the variables an enclosing atc session sets.
The [`isolate-home`](../../../packages/test-utils/src/isolate-home.ts) preload stops a bare
`bun test` before any test runs: Bun hands a spawned child the environment it started with, so a
home a preload sets never reaches a test's subprocesses.

- Derive a home path from [`resolveHomeDir`](../../../packages/config/src/host/resolve-home-dir.ts),
  never `os.homedir()`: Bun reads `HOME` for `os.homedir()` once at startup, so a home set after
  startup never moves it.
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
  harness's stand-in `claude`. One exception: `bun run test:atc-bridge` runs
  `claude plugin validate` and `claude plugin test` on the mod, and neither starts a session.
- The Claude config lock's test runs against `proper-lockfile`, the lock library Claude Code
  bundles, because no test runs Claude itself.

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
