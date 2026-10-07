---
name: project-testing
description:
  atc's own testing rules on top of the shared testing skill — the mock-free PTY-e2e regime, the
  fake-claude harness, screen-byte assertion patterns and their races, and the daemon-phase rules
  for protocol and transport tests. Load together with the testing skill when designing, writing, or
  reviewing atc tests.
---

# atc testing

atc is a single-regime repo: every test is mock-free and asserts on real behaviour end to end. The
TUI is tested by spawning the real binary inside a `bun-pty` pseudo-terminal, driving it with
keystrokes, and asserting on captured screen bytes. The stand-ins are the fake `claude` and
`fake-grok` scripts. Both are boundary mocks kept high-fidelity: they emit hook events through the
real reporter (`src/hook-report.ts`) over the real socket, so everything after the boundary is
production code.

- A PTY journey test may chain dependent act-assert phases (spawn → state → kill): booting the TUI
  is the expensive arrange, and the phases exercise one flow. Each journey still has one subject,
  named in its title.
- The end-to-end suites that run the whole program live in `e2e/` at the repo root; every other test
  sits beside its module.
- A factory arrives only when a domain type crosses module boundaries, and none does yet.

## The test home

Every test run gets its own home, so no test reads or writes your real config, state, sockets, agent
homes, or git config. The package test scripts start through `scripts/with-test-home.sh`, which
points `HOME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
`XDG_CACHE_HOME`, `GROK_HOME`, and `CODEX_HOME` at a fresh temporary directory before Bun starts,
records it in `ATC_TEST_HOME`, and drops an enclosing session's `ATC_SESSION_ID` and `ATC_SOCKET`.
Run tests through `bun run test`, adding file paths or flags after it. The
`src/test-utils/isolate-home.ts` preload stops a bare `bun test` before any test runs: Bun hands a
spawned child the environment it started with, so a home a preload sets never reaches a test's
subprocesses.

- Derive a home path from `resolveHomeDir()`, never `os.homedir()`: Bun reads `HOME` for
  `os.homedir()` once at startup, so a home set after startup never moves it.
- Never move `HOME` after startup, with `updateEnv` or otherwise. A module that needs a home takes
  the path as an argument, and the test passes a path under its temp root. A spawned child still
  gets its own home through the environment it starts with.
- Override an environment variable with `updateEnv(key, value)` from `src/test-utils/update-env.ts`,
  passing `undefined` to unset it, and write no restore code. The `src/test-utils/isolate-home.ts`
  preload puts every overridden variable back after each test, so a test that moves `GROK_HOME` or
  `PATH` leaves the test home's own value for the next test. When an override exists only to steer
  where a module writes, such as `TMPDIR` for a staging directory, pass the path into the module
  instead.
- `bun run test:isolation` runs a gate inside a synthetic home of canary files and fails when the
  gate reads, changes, or adds to them. Run it after adding anything that writes generated state. It
  runs on Linux with GNU coreutils only, and stops with a message anywhere else; no canary check
  covers macOS or BSD.

## The PTY harness

Patterns specific to driving the real TUI, each learned from a real failure:

- `setupTest()` builds a fresh temp `$HOME` (config, fake claude, state dirs) per test — the suite
  exercises on-disk state (`atc.db`, transcripts, `status.json`), so isolation is directory-level.
  Dispose kills the PTY and removes the tree.
- The fake `claude` is a bash script that prints a recognizable marker, then emits `SessionStart`
  (with `session_id` and a `transcript_path` under the temp home) and a `Notification` through the
  real reporter, then sleeps. Extend scenarios by dropping files into the temp home (a
  `fake-transcript.jsonl` with a `custom-title` line), not by adding flags to the script.
- Assert on screen bytes through a polling `waitFor(needle)` helper, never a sleep. To prove that
  something never happens, wait on the signal the code emits where it decides not to act (a log
  marker, a report, a counter), then check that nothing happened.
- Clear the capture buffer before the action whose output you assert on. The buffer accumulates from
  boot; asserting against the whole run matches stale frames — the absence assertion that "passes"
  against text drawn two screens ago is the classic false positive.
- Consecutive `pty.write()` calls can coalesce into one input chunk. A control byte followed
  immediately by a printable (Ctrl-Space then `n`) can arrive as one buffer and be misread. Sequence
  dependent keys through `waitFor` on each key's observable effect.
- Pick `waitFor` needles from stable output (session names, box titles, state labels), not from hint
  lines — hint text changes with every keybinding addition and breaks tests that anchored to it.
- Control bytes in test strings are `\u0000`-style escapes or named constants
  (`CTRL_SPACE = String.fromCodePoint(0)`), never raw bytes.

## Daemon-phase rules

Ported forward now so protocol work starts under them:

- Infrastructure failures run on real transports: a connect-failure branch dials a socket path
  nothing listens on — never a stubbed connect. Handles are destroyed in `onTestFinished`.
- Delivery is proven by loss tests: blast a slow reader through the real socket and assert zero
  loss. `Bun.socket.write()` returns bytes-accepted and silently drops the rest; only a test at the
  transport catches a missing drain path.
- Failure paths are contract: assert rejections directly —
  `expect(promise).rejects.toMatchObject({ code })` — never try/catch, and test each declared error
  code.
- Arbitration and authorization rules are tested in pairs: the positive ("the first responder's
  decision applies") and the named negative ("a second responder gets `already_answered`") are two
  tests, never one test with a branch.
