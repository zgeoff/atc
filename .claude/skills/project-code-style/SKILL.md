---
name: project-code-style
description:
  atc's additions to the shared code-style skill — the comment rules. Load beside code-style before
  writing, reviewing, or renaming any TypeScript in atc.
---

# atc code style

The shared `code-style` skill holds the module layout, the acronym rule, state lifecycles, and the
function-verb taxonomy. This skill holds only what atc adds to it, and it never relaxes a rule
there.

## Key rules

- [Comments](#comments): JSDoc is multi-line, and a comment holds no history and names no other
  declaration.

## Comments

- A comment describes the code as it is, never how it got that way or what is planned, so it holds
  no history or project state.
- A comment never names another declaration, because a rename strands the reference. Describe the
  behaviour instead.
