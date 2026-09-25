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
keystrokes, and asserting on captured screen bytes. The one stand-in is the fake `claude` script, a
boundary mock kept high-fidelity: it emits hook events through the real reporter
(`src/hook-report.ts`) over the real socket, so everything after the boundary is production code.

- A PTY journey test may chain dependent act-assert phases (spawn → state → kill): booting the TUI
  is the expensive arrange, and the phases exercise one flow. Each journey still has one subject,
  named in its title.
- `test/e2e.test.ts` is the whole-binary suite and stays where it is; every other test sits beside
  its module.
- A factory arrives only when a domain type crosses module boundaries, and none does yet.

## The PTY harness

Patterns specific to driving the real TUI, each learned from a real failure:

- `setupTest()` builds a fresh temp `$HOME` (config, fake claude, state dirs) per test — the suite
  exercises on-disk state (`fleet.json`, transcripts, `status.json`), so isolation is
  directory-level. Dispose kills the PTY and removes the tree.
- The fake `claude` is a bash script that prints a recognizable marker, then emits `SessionStart`
  (with `session_id` and a `transcript_path` under the temp home) and a `Notification` through the
  real reporter, then sleeps. Extend scenarios by dropping files into the temp home (a
  `fake-transcript.jsonl` with a `custom-title` line), not by adding flags to the script.
- Assert on screen bytes through a polling `waitFor(needle)` helper, never a bare sleep. A sleep is
  legal only where no observable signal exists, and carries a comment saying what it waits out.
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
