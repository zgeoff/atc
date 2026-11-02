---
name: project-ci-design
description:
  "atc's CI facts, and the one ci-design rule it replaces: atc runs its own checks workflow in place
  of bun-checks.yml. Also how a new job becomes part of the required checks. Load it beside
  ci-design before you add or change a workflow, a job or a step in atc."
metadata:
  kind: rule-set
---

# atc CI design

## Facts

| Fact                        | Value                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visibility                  | public                                                                                                                                                                                                                                                                                                                              |
| Test budget                 | 3 min                                                                                                                                                                                                                                                                                                                               |
| `BUN_CHECK_TIMEOUT_MINUTES` | none: atc doesn't call `bun-checks.yml`                                                                                                                                                                                                                                                                                             |
| `BUN_CHECK_SCRIPTS`         | none: atc doesn't call `bun-checks.yml`                                                                                                                                                                                                                                                                                             |
| Required checks             | `checks` and `gitleaks`, both jobs in [`pr.yml`](../../../.github/workflows/pr.yml)                                                                                                                                                                                                                                                 |
| Heavy checks                | the `smoke` job of [`binaries.yml`](../../../.github/workflows/binaries.yml) on its two macOS runners, on every pull request, as ci-design allows in a public repo                                                                                                                                                                  |
| Reusable workflow pin       | a commit on `main` of zgeoff/tools, in [`repo-sync.yml`](../../../.github/workflows/repo-sync.yml), [`repo-sync-guard.yml`](../../../.github/workflows/repo-sync-guard.yml), [`audit-fix.yml`](../../../.github/workflows/audit-fix.yml) and [`main.yml`](../../../.github/workflows/main.yml); the repo-sync pull requests move it |

## Departures

- Add each CI step to [`checks.yml`](../../../.github/workflows/checks.yml), atc's own workflow. The
  Jobs section of [ci-design](../ci-design/SKILL.md) puts each package script in `bun-checks.yml`,
  but that workflow has no input for what atc's jobs need: test temp files on tmpfs, an 8 GB memory
  cap, and pinned builds of the Claude Code and Codex CLIs for the bridge tests.

## The required checks

In `pr.yml`, the `checks` job needs the `ci` job, which calls `checks.yml`, and the `binaries` job,
which calls `binaries.yml`. It fails when any job in those two workflows fails, so a step or a job
you add there needs no required check of its own.

- Add a step that runs no tests, such as a lint, to the `static` job in `checks.yml`.
- Add a step that runs tests to the `test` job in `checks.yml`. That job sets up the temp folder and
  the memory cap the suite needs.
- Add a job to `checks.yml` only when it can't be a step, such as one that needs its own runner.
- Add a job that builds or runs on macOS or on arm64 to `binaries.yml`. Add a macOS job to the Heavy
  checks row above.
- Keep `gitleaks` as its own required check. Its action comments on the pull request, so it needs
  write access to pull requests and the full git history, which no other job takes.
