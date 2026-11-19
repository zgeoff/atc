import { SESSION_ENV_NAMES } from '@atcx/contract/light';
import { z } from 'zod';

// Paths outside the session's own workspace. Only the shape is checked here: atc checks each
// entry on the session's host, where the paths actually resolve.
const SCOPE_WORKTREE = z.strictObject({ path: z.string() });
const SCOPE_BRANCH = z.strictObject({ name: z.string(), repo: z.string().optional() });
const SCOPE_PULL_REQUEST_NUMBER = z.number().int();

const SCOPE_PULL_REQUEST = z.strictObject({
  number: SCOPE_PULL_REQUEST_NUMBER,
  repo: z.string().optional(),
});

export const SCOPE_FIELD = z
  .strictObject({
    worktrees: z
      .array(SCOPE_WORKTREE)
      .optional()
      .describe('Absolute paths of git worktrees on the session host, each its worktree top level'),
    branches: z
      .array(SCOPE_BRANCH)
      .optional()
      .describe(
        "Branches that exist in repo, an absolute repository path on the session host; repo defaults to the session's directory",
      ),
    pullRequests: z
      .array(SCOPE_PULL_REQUEST)
      .optional()
      .describe(
        "GitHub pull requests of repo, as owner/name; repo defaults to the GitHub repository of the workspace's origin",
      ),
  })
  .describe(
    `Worktrees, branches, and pull requests the session may touch beyond its own workspace, at most 64 of each. atc checks worktrees and branches on the session's host and pull requests with gh on the atc daemon's host. The first invalid or unknown entry refuses the whole scope with scope_invalid naming it, and atc records none of it. A valid scope goes into the session's record, which the session reads at $${SESSION_ENV_NAMES.sessionRecord}.`,
  );
