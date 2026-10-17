<!--
Issues live in Linear. When the PR works on one, scope the title with
its ID in lower case, `feat(geo-123): add the retry budget`, and start
the body with one line that states the relationship:

Fixes GEO-123          merging completes the issue
Contributes to GEO-123 the PR delivers part of it; work remains
Related to GEO-123     context only

Omit the line when the PR has no issue.
-->

## Description

<!--
Lead paragraph: ≤2 sentences, what changed and why. Then bullets:
one line each, no **bold-label:** prefixes, no semicolon chains.
Cover decisions, deviations, and tradeoffs — not a diff inventory;
if the diff shows it plainly, don't restate it. Whole section ≤150
words. No narrative about prior attempts or review cycles.
-->

## Testing

- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes
- [ ] `bun run lint` passes
- [ ] New tests added for new functionality

## Context

<!--
Only what the diff can't show (external constraints, follow-up plans).
Delete this section by default.
-->
