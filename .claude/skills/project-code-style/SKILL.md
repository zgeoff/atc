---
name: project-code-style
description:
  atc's additions to the shared code-style skill — the names exempt from the verb rule and the
  comment rules. Load beside code-style before writing, reviewing, or renaming any TypeScript in
  atc.
---

# atc code style

The shared `code-style` skill holds the module layout, the acronym rule, state lifecycles, and the
function-verb taxonomy. This skill holds only what atc adds to it, and it never relaxes a rule
there.

## Key rules

- [Exempt names](#exempt-names): a name that a library contract fixes keeps its banned verb.
- [Comments](#comments): JSDoc is multi-line, and a comment holds no history and names no other
  declaration.

## Exempt names

The verb rule skips these names, because a library fixes each one. Each also sits in the
`exemptNames` option of `zgeoff/function-verb` in [`.oxlintrc.json`](../../../.oxlintrc.json).

- `fetch`, the request handler that `Bun.serve` calls
- `executeQuery`, a method of kysely's `Driver` interface, which
  [`BunSqliteDriver`](../../../packages/store/src/sqlite/bun-sqlite-driver.ts) implements under the
  name the library requires

## Comments

- A comment describes the code as it is, never how it got that way or what is planned, so it holds
  no history or project state.
- A comment never names another declaration, because a rename strands the reference. Describe the
  behaviour instead.
