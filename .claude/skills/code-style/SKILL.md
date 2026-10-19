---
name: code-style
description:
  Code style for zgeoff TypeScript repos — module layout and file naming, acronyms, state
  lifecycles, branching on a union with ts-pattern, and the role table of function verbs whose
  promises the function-verb and verb-contract lint rules check. Load before writing, reviewing, or
  renaming any TypeScript, with the repo's project-code-style skill beside it.
---

# Code style

Mechanically enforced rules (oxfmt, oxlint, format-codemod) aren't repeated here — this skill covers
what tooling can't check.

## Key rules

Each line links the section that explains it.

- [Files and modules](#files-and-modules): one primary export per file, named for it, with private
  helpers after it.
- [Acronyms](#acronyms): acronyms stay uppercase in identifiers, `ID` included, unless one starts a
  name.
- [Naming values](#naming-values): a variable, parameter or property is named for what it holds, in
  full words, with no single letters or abbreviations outside a short kept list.
- [State lifecycles](#state-lifecycles): persisted state moves through one declared transition
  table, and an in-process actor is an xstate machine.
- [Branching on a union](#branching-on-a-union): branch with `match(...).exhaustive()` from
  `ts-pattern`, never `switch`.
- [Function naming](#function-naming): a function that does a job in the role table starts with that
  job's verb and keeps its promise, and the banned verbs never appear.

## Loading the skill

This skill is the shared base that repo-sync delivers from zgeoff/tools; edit it there, never in a
downstream repo. When the repo has a `project-code-style` skill, load it too. It holds the repo's
own rules, and it only adds to this skill: a stricter rule, never an exception.

## Files and modules

- One primary export per file, and the file name kebab-cases that export (`with-jest-context.ts`
  exports `withJestContext`). Exceptions: `index.ts` entrypoints, `types.ts` for a package's shared
  types, and side-effect-only modules, which are named for what they do (`augment-bun-test.ts`).
- Module order: imports, the primary export, then private helpers in composition order (depth-first)
  — never helpers first. Supporting declarations (consts, interfaces, type aliases) sit directly
  above their first use, never below it and never leading the file. The exception: declarations the
  primary export uses may sit just above it. `zgeoff/module-order` reports each break, and its fix
  moves each declaration it can move safely.
- Build objects with a factory function, never a class. The factory takes the verb its result needs:
  `build<X>` for a value, `create<X>` for a resource, and `make<X>` for a function. The one
  exception is a custom error, `class <X>Error extends Error`, since `instanceof` checks and stack
  traces need it. `zgeoff/no-class` fails any other class.

## Acronyms

Acronyms stay uppercase in identifiers (`runCLI`, `parseCLIArgs`, `ASTNode`, `packageURL`,
`isPackageJSON`) — except when one starts a camelCase name, where it lowercases whole (`cliPath`,
`astNode`). ID counts as an acronym: `userID`, `sessionID` — never `userId` — and `idToken` when it
starts a name. File names are unaffected: kebab-case lowercases everything (`parse-cli-args.ts`
exports `parseCLIArgs`).

## Naming values

Name a variable, parameter or property for what it holds, in full words: `manager`, never `mgr`, and
`session`, never `s`. A full word tells the reader what the value is without a trip to where it was
made. Single letters and abbreviations are banned.

A few short names are kept:

- `x` and `y`, for coordinates.
- `z` for zod, `$` for Bun's shell, and `_` for a placeholder that is never read.
- `ctx` and `id`.
- `db`, `args`, `params`, `repo` and `info`, which read as words.

A unit keeps its short form as a suffix, as in `timeoutMs`, but `ms` alone never names a value.
Acronyms follow [Acronyms](#acronyms). A type parameter, such as `T`, is not a value, and this rule
leaves it alone.

Lint catches the mechanical cases. `id-length` fails a one-letter name other than the kept ones, and
`zgeoff/no-abbreviated-names` fails each abbreviation its options list, with the full word in its
message. An abbreviation outside that list, such as `cfg`, breaks this rule all the same.

## State lifecycles

State that is persisted, or that leaves the process (sent to a client or another process), moves
through a declared transition table: the states, the moves allowed between them, and one check, in
the one place that writes the state, that refuses a move the table lacks. A long-lived actor whose
states live only inside one process, such as a reconnecting transport or an interactive client, is
an xstate machine instead, because its states last only as long as the process and xstate keeps its
events, guards and timers in one definition. An actor that persists part of its state keeps a
transition table for that part. Write the table before a module that owns the state splits, so the
modules the split creates share one copy of the rule instead of each keeping its own.

## Waiting on time and events

Wait on a timer with `Bun.sleep` in a script or test that only Bun runs. Code that ships to Node
waits with `setTimeout` from `node:timers/promises`, because Node has no `Bun` global. Wait on one
event with `events.once`. When a caller resolves a promise from outside, take the parts from
`Promise.withResolvers()`. Hand-build a `new Promise` only when none of these fits, such as an event
that can also fail through a second event.

## Branching on a union

Branch on a union with `match(...).exhaustive()` from `ts-pattern`, never with `switch`. The
`exhaustive()` call fails the type check when a member of the union has no branch, so a member added
later cannot fall through to a default. `zgeoff/no-switch` reports every `switch`, but only the
author can tell a union from an open value. End the match with `.otherwise()` only when the value is
open, such as a string from outside the program.

## Function naming

A function that does a job in the role table starts with that job's verb, and the verb makes a
promise the reader relies on without opening the function. Any other function starts with any verb
that fits what it does. `zgeoff/function-verb` fails a banned verb, and `zgeoff/verb-contract` fails
each broken promise that a machine can see. The `@zgeoff/oxlint-config` README lists what
verb-contract counts as I/O.

| Role                                                  | Verb                         | Promise                                     |
| ----------------------------------------------------- | ---------------------------- | ------------------------------------------- |
| yes/no answer                                         | `is`, `has`, `can`, `should` | returns a boolean; no I/O                   |
| yes/no answer that needs I/O                          | `probe`                      | returns a boolean; may do I/O               |
| value from arguments, test data factories included    | `build`                      | no I/O                                      |
| text or raw input → structure                         | `parse`                      | no I/O                                      |
| value → text or markup                                | `format`, `render`           | no I/O                                      |
| choice among known alternatives                       | `pick`                       | no I/O                                      |
| lookup that can miss                                  | `find`                       | no I/O; can return null or undefined        |
| lookup that cannot miss                               | `get`                        | no I/O; never returns null or undefined     |
| many values gathered from a traversal                 | `collect`                    | no I/O                                      |
| cheap change of representation                        | `to`                         | no I/O                                      |
| content in from outside the process                   | `read`                       | may do I/O                                  |
| content out to outside the process                    | `write`                      | may do I/O                                  |
| subprocess or task                                    | `run`                        | may do I/O                                  |
| resource brought into existence                       | `create`                     | may do I/O                                  |
| resource taken away                                   | `remove`                     | may do I/O                                  |
| function that returns a function                      | `make`                       | returns a function                          |
| higher-order wrapper                                  | `with`                       | runs a callback inside a context            |
| React hook                                            | `use`                        | follows the rules of hooks                  |
| event-callback prop or parameter                      | `on`                         | follows the framework's callback convention |
| function passed to an `on` prop, or a lifecycle event | `handle`                     | follows the framework's callback convention |
| test wiring                                           | `setupTest`                  | the testing skill's per-test fixture        |

`make`, `with`, `use`, `on` and `to` always take a suffix, as in `toPosixPath`.

### The I/O rule

A function that does I/O starts with a verb that may do I/O, and never with a verb whose promise is
no I/O. A pure function stays pure all the way down: a `build` function that calls a `read` helper
does I/O. verb-contract skips a callee from a package, so a pure function that calls a package's
I/O, or a local helper whose name hides its I/O, passes lint and still breaks the rule.

A function that returns a boolean and does no I/O starts with `is`, `has`, `can` or `should`. Two
exceptions:

- A function with an effectful verb, such as `removeFile` or `tryLock`, may return a success flag.
- A framework prefix wins: a React hook that returns a boolean keeps `use`, and a callback keeps
  `on` or `handle`.

### Data or resource

A test data factory is `build<X>`, never `create<X>` or `make<X>`. `create` is for a resource, such
as a file, a stub binary or a server.

### Free verbs

A function whose job has no row in the table may start with a verb outside it. That verb is free: it
makes no promise. A job with a row keeps its row's verb, so a pure yes/no answer starts with `is`,
`has`, `can` or `should` even when a free verb such as `matches` reads well. `resolve` is free
because it names both a pure lookup and one that searches the filesystem, so a reader opens a
`resolve` function to learn which.

### Banned verbs

Banned verbs never start a function name. The vague ones say nothing about what the function does,
so name what it does instead: `process`, `manage`, `do`, `perform`, and `handle` outside its
callback use. The others are near-synonyms of a table verb, and lint names the replacement:
`execute` (→ `run`), `compute` (→ `build`), `fetch` (→ `read`), `save` and `store` (→ `write`),
`delete` (→ `remove`), and `search` and `lookup` (→ `find`).

### Changing the table

A change to the role table, to the banned verbs, or to the effectful verbs that verb-contract counts
as I/O is a change to zgeoff/tools, where the skill and both rules change in one PR, and it needs
the maintainer's approval. A new free verb needs no change and no approval.
