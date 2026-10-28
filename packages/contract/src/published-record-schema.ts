import { z } from 'zod';
import type { PublishedRecord } from './published-record';

const WORKSPACE_SCOPE_SCHEMA = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  repoURL: z.string().nullable(),
  sha: z.string().nullable(),
});

const WORKTREE_SCOPE_SCHEMA = z.object({ path: z.string(), branch: z.string().nullable() });
const BRANCH_SCOPE_SCHEMA = z.object({ name: z.string(), repo: z.string() });

const PULL_REQUEST_SCOPE_SCHEMA = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  branch: z.string(),
});

// What a session's record holds as its work: workspace, worktrees, branches, and pull requests.
const SCOPE_SCHEMA = z.object({
  workspace: WORKSPACE_SCOPE_SCHEMA,
  worktrees: z.array(WORKTREE_SCOPE_SCHEMA),
  branches: z.array(BRANCH_SCOPE_SCHEMA),
  pullRequests: z.array(PULL_REQUEST_SCOPE_SCHEMA),
});

export const PUBLISHED_RECORD_SCHEMA: z.ZodType<PublishedRecord, PublishedRecord> = z.object({
  format: z.literal('atc.session-record'),
  version: z.literal(1),
  session: z.string(),
  daemonID: z.string(),
  target: z.string(),
  revision: z.number().int().min(1),
  updatedAt: z.string(),
  name: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  spawner: z.string().nullable(),
  scratch: z.string().nullable(),
  scope: SCOPE_SCHEMA,
});
