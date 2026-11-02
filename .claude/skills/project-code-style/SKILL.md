---
name: project-code-style
description:
  "atc's lint, format and type-check commands, and the one folder that doesn't follow the shared
  code-style skill: the Claude Code mod in mods/. Load it beside code-style before you write or
  review TypeScript in atc."
metadata:
  kind: rule-set
---

# atc code style

## Facts

| Fact               | Value                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Lint command       | `bun run lint:full`; `bun run lint:mods` for `mods/`. CI runs both                                                                  |
| Lint config        | [`.oxlintrc.json`](../../../.oxlintrc.json), which skips `mods/`; [`.oxlintrc.mods.json`](../../../.oxlintrc.mods.json) for `mods/` |
| Format command     | `bun run format` formats the whole repo; the pre-commit hook formats staged files; CI runs `bun run format:check`                   |
| Type-check command | `bun run typecheck`, over the `include` list in [`tsconfig.json`](../../../tsconfig.json), which leaves out `mods/`                 |

## Departures

- In `mods/`, skip code-style's rules. Each folder there, such as `mods/atc-bridge/`, is a Claude
  Code mod, and Claude Code's mod API decides how its code looks. `.oxlintrc.mods.json` checks only
  which packages a mod imports and how it imports them, and `bun run test:atc-bridge` checks the mod
  with `claude plugin validate` and `claude plugin test`.
