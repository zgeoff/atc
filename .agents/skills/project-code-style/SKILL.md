---
name: project-code-style
description:
  "The one folder of atc that doesn't follow the shared code-style skill: the Claude Code mod in
  mods/. Load it beside code-style before you write or review TypeScript in atc."
metadata:
  kind: rule-set
---

# atc code style

## Departures

- In `mods/`, skip code-style's rules. Each folder there, such as `mods/atc-bridge/`, is a Claude
  Code mod, and Claude Code's mod API decides how its code looks.
  [`.oxlintrc.mods.json`](../../../.oxlintrc.mods.json) checks only which packages a mod imports and
  how it imports them, and `bun run test:atc-bridge` checks the mod with `claude plugin validate`
  and `claude plugin test`.
