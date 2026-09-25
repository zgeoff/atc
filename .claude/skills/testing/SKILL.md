---
name: testing
description:
  Shared testing conventions for zgeoff Bun repos — flat behavioural tests, arrange-act-assert,
  setupTest with await using, no lifecycle hooks or local helpers, strict assertions, inline data
  and snapshots, jest-extended matchers, and the no-branching and no-mock rules. Load when
  designing, writing, or reviewing tests.
---

# Testing

`bun test` runs every file in one process with no per-file isolation. Process-wide lifecycle and
cleanup register once in the `bunfig.toml` preload, and test files carry no lifecycle hooks. A test
exercises real behaviour: pure modules assert on return values, file-touching units use `mkdtemp`
trees, and a CLI is asserted end to end by spawning the real binary. A module that is hard to test
without mocking moves its I/O to the caller.

This skill is the shared base that repo-sync delivers from zgeoff/tools; edit it there, never here.
When the repo has a `project-testing` skill, load it too: it holds the harnesses, regimes, and
exceptions specific to this repo, and where the two disagree, the project skill wins.

## Principles

The rules below decide most situations; where they don't, these do:

- Clarity over abstraction: repetition in a test isn't a smell, hidden setup is.
- Isolation is non-negotiable: every test passes alone and in any order.
- Test behaviour, not implementation: a refactor that preserves the observable contract breaks no
  test.
- Every mock is a divergence from reality: mock only what is genuinely out of reach, and keep it
  high-fidelity — correct codes, realistic shapes, shared types.
- Test utilities are production code: anything a test file would grow beyond a local `setupTest()`
  moves to a shared test util with its own test.
- Assertions are the contract: one loose assertion makes the rest of the test theatre.

## Structure

- Never use `describe` — write flat `test(…)` blocks with behavioural titles that start with "it"
  (`test('it pads before a return statement', …)`).
- A title describes observable behaviour, never an internal identifier, and reads verb + outcome +
  condition (`it rejects a header longer than 72 characters`, not `it sets isValid to false`).
- A test body arranges, acts, asserts — phases separated by blank lines, never `// arrange`
  comments. A body with two unrelated act-assert pairs is two tests.
- `test.each` only for a closed decision table: data-only rows and a title template that starts with
  "it" and interpolates the distinguishing input. Anything else is one `test()` per case.
- Test files sit beside the module they test (`parse-source.ts` beside `parse-source.test.ts`) — no
  `test/`, `tests/`, or `__tests__` directories.

## Setup and lifecycle

- No `beforeAll`/`beforeEach`/`afterEach`/`afterAll` in test files. A per-test resource comes from a
  local `setupTest()` that returns named props plus `Symbol.asyncDispose` (or `Symbol.dispose`),
  held with `await using`, so teardown runs whether the test passes or throws.

  ```ts
  async function setupTest() {
    const dir = await mkdtemp(join(tmpdir(), 'parse-source-'));

    return {
      dir,
      async [Symbol.asyncDispose]() {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  test('it reads an empty file as no entries', async () => {
    await using project = await setupTest();

    await writeFile(join(project.dir, 'entries.txt'), '');

    expect(await readEntries(project.dir)).toStrictEqual([]);
  });
  ```

- `setupTest` is the only function a test file declares, and the file holds no module-level fixture
  or baseline shared between tests. Any other helper — a data builder, an assertion wrapper, a
  parsing shim, a poll loop — is inlined at the call site, replaced by a registered matcher, or
  extracted to a shared test util with its own test.
- `setupTest` wires runtime — temp trees, servers, clients, recorders — and returns no domain data.
  The scenario is written in the test body.
- Hold the `setupTest` result in one named const and access its members; never destructure it into
  loose consts.
- State the preload owns (matcher registration, store resets, mock restores) needs no per-test
  handling. A test that mutates global state the preload doesn't own restores it in
  `onTestFinished(...)`, never `try`/`finally`.
- A test that passes alone but fails in the full run has a cleanup gap: find the leaked state and
  add its reset to the preload. Reordering tests or picking unique keys hides the gap.

## Data

- Plain arguments, options bags, and config are written inline at the call site, even when tests
  repeat the literal. Repeated data reads; an opaque baseline doesn't.
- A domain type that crosses module boundaries gets a faker-defaulted `create-mock-*` factory in the
  repo's shared test utils, with its own test; the test overrides only the fields the unit reads. A
  type local to the module under test stays an inline literal.
- A unit that parses or validates raw input is tested with inline literal payloads, valid and
  invalid, never factory output — a factory built to satisfy a schema cannot falsify it.

## Assertions

- `toStrictEqual` when the test determines every field — the full shape is the contract.
  `toMatchObject`, or asymmetric matchers inside `toStrictEqual`, when the value carries fields the
  test doesn't determine. Choosing partial because the full literal is long is a defect. Never
  `toEqual`.
- Snapshots are inline only: `toMatchInlineSnapshot` pins deterministic machine output no human
  derives by reading the code. File-based snapshots never appear.
- A thrown error is asserted at the strictness its contract demands: bare `toThrow()` when only
  throwing matters, `toThrowWithMessage(Error, /…/)` when the message is contract, and a typed
  rejection narrows on its `code`, never on the message.
- No branching in a test body. Narrowing a maybe-value is an explicit `throw` or `invariant(...)` on
  the line before the assertion — never `?.`/`??` fallbacks inside `expect` arguments, which turn a
  missing value into a passing comparison. A conditional path means two tests.
- An assertion inside a callback the unit may never invoke passes vacuously — capture into a const
  outside the callback and assert after it returns.
- A wall-clock-dependent value is built relative to `Date.now()` and asserted with range matchers
  (`toBeAfter`, `toBeWithin`), never an exact timestamp. Waiting on an async condition is a polling
  `waitFor`, never a bare sleep.

## Matchers

jest-extended matchers come from the `@zgeoff/bun-test-extended` preload, and an unknown matcher
name fails typecheck. Reach for them instead of hand-rolling assertions:

- arrays: `toIncludeAllMembers`, `toIncludeSameMembers`, `toPartiallyContain`,
  `toIncludeAllPartialMembers`, `toSatisfyAll`
- objects: `toContainEntry`, `toContainEntries`, `toContainAllKeys`, `toBeFrozen`
- strings: `toStartWith`, `toEndWith`, `toInclude`, `toEqualCaseInsensitive`,
  `toEqualIgnoringWhitespace`
- values: `toBeNil`, `toBeOneOf`, `toSatisfy`, `toBeWithin`, `toBeEmpty`
- dates: `toBeAfter`, `toBeBefore`, `toBeBetween`, `toBeValidDate`
- mocks: `toHaveBeenCalledOnce`, `toHaveBeenCalledExactlyOnceWith`, `toHaveBeenCalledBefore`,
  `toHaveBeenCalledAfter`
- errors and async: `toThrowWithMessage`, `toResolve`, `toReject` (both return a promise — always
  `await`)

Matchers also work asymmetrically inside `toStrictEqual`/`toMatchObject`
(`status: expect.toBeOneOf([…])`). `expect(...).rejects`/`.resolves` chains stay unawaited: Bun's
types declare them synchronous.
