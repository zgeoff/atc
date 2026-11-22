---
name: project-code-style
description:
  "The one folder of atc that doesn't follow the shared code-style skill: mods/, which holds the
  Claude Code mods. Load it beside code-style before you write or review TypeScript in atc."
metadata:
  kind: rule-set
---

# atc code style

## Departures

- In `mods/`, skip code-style's rules. Each folder there, such as `mods/atc-bridge/`, is a Claude
  Code mod, and Claude Code's mod API decides how its code looks.
- In place of code-style, `bun run lint:mods` checks every mod for which packages it imports and
  how, by the rules in [`.oxlintrc.mods.json`](../../../.oxlintrc.mods.json). lefthook runs it
  before each push, and CI runs it too.
- After you change `mods/atc-bridge/`, run `bun run build:atc-bridge` to regenerate the copy of the
  mod that atc embeds; CI fails on a stale copy. Then run `bun run test:atc-bridge`. The test runs
  `claude plugin validate` and `claude plugin test` on that mod alone, so it needs the `claude` CLI
  on your `PATH`.
