import { z } from 'zod';
import type { PublishedRecord } from '../protocol/published-record';

const NULLABLE_STRING = z.string().nullable();

const WORKSPACE_SCHEMA = z.object({
  path: z.string(),
  branch: NULLABLE_STRING,
  repoURL: NULLABLE_STRING,
  sha: NULLABLE_STRING,
});

const WORKTREE_SCHEMA = z.object({ path: z.string(), branch: NULLABLE_STRING });
const BRANCH_SCHEMA = z.object({ name: z.string(), repo: z.string() });

const PULL_REQUEST_SCHEMA = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  branch: z.string(),
});

const SCOPE_SCHEMA = z.object({
  workspace: WORKSPACE_SCHEMA,
  worktrees: z.array(WORKTREE_SCHEMA),
  branches: z.array(BRANCH_SCHEMA),
  pullRequests: z.array(PULL_REQUEST_SCHEMA),
});

const REVISION = z.number().int().positive();

const PUBLISHED_RECORD_SCHEMA = z.object({
  format: z.literal('atc.session-record'),
  version: z.literal(1),
  session: z.string(),
  daemonID: z.string(),
  target: z.string(),
  revision: REVISION,
  updatedAt: z.string(),
  scope: SCOPE_SCHEMA,
});

/**
 * Reads a published record back from the JSON the state store holds; null
 * for text that is not a version 1 record.
 */
export function parsePublishedRecord(text: string): PublishedRecord | null {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = PUBLISHED_RECORD_SCHEMA.safeParse(raw);

  return parsed.success ? parsed.data : null;
}
