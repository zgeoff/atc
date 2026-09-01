---
name: testing
description:
  atc testing conventions — the mock-free PTY-e2e regime, the fake-claude harness, screen-byte
  assertion patterns and their races, assertion discipline (toStrictEqual, inline snapshots,
  jest-extended), and the daemon-phase rules for protocol and transport tests. Load when designing,
  writing, or reviewing tests.
---

# Testing

`bun test` runs every file in one process. atc is a single-regime repo: the pure-package regime —
mock-free, asserting on real behavior end to end. The TUI is tested by spawning the real binary
inside a `bun-pty` pseudo-terminal, driving it with keystrokes, and asserting on captured screen
bytes. File-touching units use temp trees (`mkdtemp`), never mocked filesystems. The one stand-in is
the fake `claude` script, and it is a boundary mock kept high-fidelity: it emits hook events through
the real reporter (`src/hook-report.ts`) over the real socket, so everything after the boundary is
production code.

## Principles

- Clarity over abstraction: repetition in a test isn't a smell, hidden setup is.
- Isolation is non-negotiable: every test passes alone and in any order.
- Test behavior, not implementation: a refactor that preserves the observable contract breaks no
  test.
- Every mock is a divergence from reality: mock only what is genuinely out of reach (the real
  `claude` binary), and keep it high-fidelity.
- Test utilities are production code, extracted and tested with the same rigor.
- Assertions are the contract: one loose assertion makes the rest of the test theatre.

## Everywhere

- Never use `describe` — flat `test(…)` blocks with behavioral titles that start with "it"
  (`test('it restores the fleet from disk after a crash', …)`). Titles describe observable behavior,
  never internal identifiers: verb + outcome + condition.
- A test body arranges, acts, asserts — phases separated by blank lines, never `// arrange`
  comments. A body with two unrelated act-assert pairs is two tests. One deliberate exception: a PTY
  journey test may chain dependent act-assert phases (spawn → state → kill), because booting the TUI
  is the expensive arrange and the phases exercise one flow — but each journey still has one
  subject, named in its title.
- `test.each` only for a closed decision table — data-only rows, title template starting with "it".
  Anything else is one `test()` per case.
- No branching in a test body: narrowing a maybe-value is an explicit `throw` (or `invariant`) on
  the line before the assertion — never `?.`/`??` fallbacks inside `expect` arguments, which turn a
  missing value into a passing comparison. A conditional path in a test means two tests.
- An assertion inside a callback the unit may never invoke passes vacuously — capture into a const
  outside the callback and assert after it returns.
- Lifecycle: no `beforeAll`/`beforeEach`/`afterEach`/`afterAll` in test files. Per-test resources
  come from a local `setupTest()` returning named props plus `Symbol.asyncDispose`, held with
  `await using`. State the preload owns (jest-extended registration) needs no per-test handling; a
  test that mutates globals the preload doesn't own restores them in `onTestFinished(...)`, never
  `try`/`finally`.
- `setupTest` is the only local function a test file defines. Every other helper is inlined into the
  test bodies or extracted to a shared util under `test/`, tested beside itself — a second setup
  shape, a local poll loop, or a parsing shim hides what the test arranges.
- Unit tests co-locate with the module they test (`pick-matches.ts` beside `pick-matches.test.ts`);
  `test/e2e.test.ts` is the whole-binary suite and stays where it is.
- `toStrictEqual` when the test determines every field — the full shape is the contract.
  `toMatchObject`, or asymmetric matchers inside `toStrictEqual`, when the value carries fields the
  test doesn't determine. Choosing partial because the full literal is long is a defect. Never
  `toEqual`.
- Snapshots are inline only: `toMatchInlineSnapshot` pins deterministic machine output no human
  derives by reading the code. File-based snapshots never appear.
- Plain arguments, options bags, and config are written inline at the call site, even when tests
  repeat the literal. No baseline-builder helpers, no module-level fixtures shared between tests.
  Faker-defaulted `create-mock-*` factories arrive only when a domain type crosses module boundaries
  — none does yet.
- Reach for jest-extended matchers (registered by the `@zgeoff/bun-test-extended` preload) instead
  of hand-rolling assertions: `toInclude`, `toStartWith`, `toBeOneOf`, `toSatisfy`, `toBeWithin`,
  `toIncludeAllMembers`, `toThrowWithMessage`, `toResolve`/`toReject` (both awaited). They also work
  asymmetrically inside `toStrictEqual`.
- A wall-clock-dependent value is built relative to `Date.now()` and asserted with range matchers
  (`toBeAfter`, `toBeWithin`), never with exact timestamps.

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
