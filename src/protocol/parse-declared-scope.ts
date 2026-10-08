import { z } from 'zod';

/**
 * The scope a caller declares for a session, before atc checks any entry
 * against the session's host.
 */
export interface DeclaredScope {
  readonly worktrees: readonly { readonly path: string }[];
  readonly branches: readonly { readonly name: string; readonly repo?: string }[];
  readonly pullRequests: readonly { readonly number: number; readonly repo?: string }[];
}

export type ParsedDeclaredScope =
  | { readonly ok: true; readonly scope: DeclaredScope }
  | { readonly ok: false; readonly entry: string; readonly message: string };

// An absolute path without `.` or `..` segments or control characters, so
// the host resolves it to the directory it holds as written.
const ABSOLUTE_PATH = z
  .string({ error: 'a path must be a string' })
  .startsWith('/', 'a path must be absolute')
  .max(4096, 'a path must be at most 4096 characters')
  .refine(
    (path) => !path.split('/').some((segment) => segment === '.' || segment === '..'),
    'a path must not hold . or .. segments',
  )
  .refine((path) => !hasControlCharacter(path), 'a path must not hold control characters');

const BRANCH_NAME = z
  .string({ error: 'a branch name must be a string' })
  .min(1, 'a branch name must not be empty')
  .max(255, 'a branch name must be at most 255 characters')
  .refine((name) => !name.startsWith('-'), 'a branch name must not start with -')
  .refine((name) => !hasControlCharacter(name), 'a branch name must not hold control characters');

// A GitHub repository as `owner/name`.
const GITHUB_REPO = z
  .string({ error: 'a pull request repo must be a string' })
  .regex(/^[\w.-]+\/[\w.-]+$/u, 'a pull request repo is a GitHub repository as owner/name');

// How many entries one list of a declared scope holds at most.
const MAX_ENTRIES = 64;

const WORKTREE_ENTRY = z.strictObject(
  { path: ABSOLUTE_PATH },
  { error: buildEntryError('a worktree holds only path') },
);

const BRANCH_ENTRY = z.strictObject(
  { name: BRANCH_NAME, repo: ABSOLUTE_PATH.optional() },
  { error: buildEntryError('a branch holds only name and repo') },
);

const PULL_REQUEST_NUMBER = z
  .number({ error: 'a pull request number must be a number' })
  .int('a pull request number must be a whole number')
  .positive('a pull request number must be positive');

const PULL_REQUEST_ENTRY = z.strictObject(
  { number: PULL_REQUEST_NUMBER, repo: GITHUB_REPO.optional() },
  { error: buildEntryError('a pull request holds only number and repo') },
);

const SCOPE = z.strictObject(
  {
    worktrees: z
      .array(WORKTREE_ENTRY, { error: 'worktrees must be a list' })
      .max(MAX_ENTRIES, `worktrees holds at most ${MAX_ENTRIES} entries`)
      .optional(),
    branches: z
      .array(BRANCH_ENTRY, { error: 'branches must be a list' })
      .max(MAX_ENTRIES, `branches holds at most ${MAX_ENTRIES} entries`)
      .optional(),
    pullRequests: z
      .array(PULL_REQUEST_ENTRY, { error: 'pullRequests must be a list' })
      .max(MAX_ENTRIES, `pullRequests holds at most ${MAX_ENTRIES} entries`)
      .optional(),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? 'a scope holds only worktrees, branches, and pullRequests'
        : 'scope must be an object',
  },
);

/**
 * Reads a declared scope off the wire. Every object is closed, so a key the
 * format does not define refuses the scope, and a refusal holds the entry
 * at fault, such as `scope.branches[1]`.
 */
export function parseDeclaredScope(raw: unknown): ParsedDeclaredScope {
  const result = SCOPE.safeParse(raw);

  if (result.success) {
    return {
      ok: true,
      scope: {
        worktrees: result.data.worktrees ?? [],
        branches: (result.data.branches ?? []).map((branch) =>
          branch.repo === undefined
            ? { name: branch.name }
            : { name: branch.name, repo: branch.repo },
        ),
        pullRequests: (result.data.pullRequests ?? []).map((pr) =>
          pr.repo === undefined ? { number: pr.number } : { number: pr.number, repo: pr.repo },
        ),
      },
    };
  }

  const [issue] = result.error.issues;

  if (issue === undefined) {
    return { ok: false, entry: 'scope', message: 'scope is invalid' };
  }

  const entry = formatEntry({
    path: issue.path,
    unrecognized: issue.code === 'unrecognized_keys' ? (issue.keys[0] ?? '') : undefined,
  });

  return { ok: false, entry, message: `${entry} is invalid: ${issue.message}` };
}

function hasControlCharacter(text: string): boolean {
  return /\p{Cc}/u.test(text);
}

// Where an issue lies: its path, and the first key a closed object refused
// when it refused one.
interface IssueLocation {
  readonly path: readonly PropertyKey[];
  readonly unrecognized?: string | undefined;
}

// The entry an issue lies in: the list and index it sits under, or the key
// a closed object refused.
function formatEntry(issue: IssueLocation): string {
  const [list, index] = issue.path;

  if (issue.unrecognized !== undefined && list === undefined) {
    return `scope.${issue.unrecognized}`;
  }

  if (typeof list !== 'string') {
    return 'scope';
  }

  return typeof index === 'number' ? `scope.${list}[${index}]` : `scope.${list}`;
}

// The message for an entry that is not an object, or that holds a key its
// kind does not define.
function buildEntryError(unrecognized: string): (issue: Readonly<{ code?: string }>) => string {
  return (issue) =>
    issue.code === 'unrecognized_keys' ? unrecognized : 'an entry must be an object';
}
