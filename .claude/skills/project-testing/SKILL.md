---
name: project-testing
description:
  atc's test harness facts on top of the shared testing skill — the per-run test home, the PTY
  harness that drives the real TUI, and socket delivery. Load together with the testing skill when
  designing, writing, or reviewing atc tests.
---

# atc testing

The shared testing skill holds every rule. This skill holds only the facts of atc's own harness that
a test author needs to follow those rules here.

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
- Change an environment variable through `updateEnv()` from `src/test-utils/update-env.ts`, never by
  assigning or deleting `process.env` keys. It records the value from before the test's first
  change, and the `isolate-home` preload puts that value back after the test.
- `bun run test:isolation` runs a gate inside a synthetic home of canary files and fails when the
  gate reads, changes, or adds to them. Run it after adding anything that writes generated state. It
  runs on Linux with GNU coreutils only, and stops with a message anywhere else; no canary check
  covers macOS or BSD.

## The PTY harness

`src/test-utils/start-tui-harness.ts` runs the real `atc` client in a `bun-pty` pseudo-terminal
inside a fresh home. These patterns each come from a real failure:

- The stand-in `claude` (`src/test-utils/build-stub-tui-claude.ts`) is a bash script that prints
  `FAKE_CLAUDE_UP args: ` with its arguments, then reports `SessionStart` through the real reporter
  over the real socket, so everything after that boundary is production code. It then reports a
  permission `Notification`, unless the home holds `fake-claude-events.jsonl`, whose hook lines it
  reports instead. Extend a scenario by dropping a file into the home, such as
  `fake-transcript.jsonl` with a `custom-title` line, not by adding flags to the script.
- Call `reset()` on the harness before the action whose output you assert on. The capture
  accumulates from boot, and an absence check against the whole run can pass on text drawn two
  screens earlier.
- Consecutive `pty.write()` calls can coalesce into one input chunk. A control byte followed at once
  by a printable (Ctrl-Space then `n`) can arrive as one buffer and be misread. Sequence dependent
  keys through `waitFor` on each key's observable effect.
- Pick `waitFor` needles from stable output (session names, box titles, state labels), not from hint
  lines: hint text changes with every keybinding addition.
- Type control bytes and escape sequences through `KEYS` from `src/test-utils/keys.ts`, never as raw
  bytes or inline escapes.

## Sockets

- `Bun.socket.write()` returns the number of bytes it accepted and silently drops the rest. Only a
  test at the transport catches a missing drain path: prove delivery by sending a slow reader more
  than one write accepts through the real socket, and assert that nothing was lost.
