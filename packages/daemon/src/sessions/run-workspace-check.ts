import { posix } from 'node:path';
import type { CommandResult, ExecutionProvider } from '@atc/plugin-api';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { REPOSITORY_ENV_UNSET_ARGV } from '../workspace/repository-env-unset-argv';

// `foreign` is a folder that is not the top of a git checkout holding the workspace's commit, or
// a symlink where atc built a folder.
export type WorkspaceCheck =
  | { readonly kind: 'checked'; readonly path: string; readonly findings: readonly string[] }
  | { readonly kind: 'unchecked'; readonly reason: string }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'missing' };

interface WorkspaceCheckRequest {
  readonly provider: Pick<ExecutionProvider, 'runCommand'>;

  // The host the workspace lies on; the daemon's own machine takes none.
  readonly host: string | null;
  readonly directory: string;

  // The commit the workspace was checked out at.
  readonly sha: string;
}

// Exit statuses of the script for each outcome other than a full answer.
const MISSING_EXIT = 80;
const FOREIGN_EXIT = 81;
const GIT_FAILED_EXIT = 82;

interface CountField {
  // A shell snippet that prints the count, and exits with the git failure status when git fails.
  readonly count: string;
  readonly singular: string;
  readonly plural: string;
}

const COUNT_NAMES = ['changes', 'hidden', 'stashes', 'worktrees', 'submodules'] as const;

// git status skips what a submodule's ignore setting or an assume-unchanged or skip-worktree flag
// hides, so the script overrides the one and counts the other; a linked worktree or a submodule
// counts as work, since no check sees inside one
const COUNT_FIELDS: Readonly<Record<(typeof COUNT_NAMES)[number], CountField>> = {
  changes: {
    count: buildLineCount('status --porcelain --untracked-files=all --ignore-submodules=none', '^'),
    singular: 'uncommitted or untracked path',
    plural: 'uncommitted or untracked paths',
  },
  hidden: {
    count: buildLineCount('ls-files -v', '^[a-zS] '),
    singular: 'path hidden from git status',
    plural: 'paths hidden from git status',
  },
  stashes: {
    count: buildLineCount('stash list', '^'),
    singular: 'stash',
    plural: 'stashes',
  },
  worktrees: {
    count: `out=$(g worktree list --porcelain) || exit ${GIT_FAILED_EXIT}; all=$(printf '%s' "$out" | grep -c '^worktree '); stale=$(printf '%s' "$out" | grep -c '^prunable'); echo $((all - 1 - stale))`,
    singular: 'linked worktree',
    plural: 'linked worktrees',
  },
  submodules: {
    count: buildLineCount('ls-files --stage', '^160000 '),
    singular: 'submodule',
    plural: 'submodules',
  },
};

// git status starts an fsmonitor that the repository's own config names, so the script turns it
// off; atc never builds a workspace as a symlink, so one there leads to a folder that is not atc's
export const WORKSPACE_CHECK_SCRIPT = `dir=$1 sha=$2
if [ -L "$dir" ]; then exit ${FOREIGN_EXIT}; fi
if [ ! -e "$dir" ]; then exit ${MISSING_EXIT}; fi
cd -P -- "$dir" || exit ${GIT_FAILED_EXIT}
here=$(pwd -P; printf x) || exit ${GIT_FAILED_EXIT}
here=\${here%?x}
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C
g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }
top=$(g rev-parse --show-toplevel) || exit ${FOREIGN_EXIT}
[ "$top" = "$here" ] || exit ${FOREIGN_EXIT}
g cat-file -e "$sha^{commit}" || exit ${FOREIGN_EXIT}
refs=$(g for-each-ref --format='%(refname)' refs/heads) || exit ${GIT_FAILED_EXIT}
${COUNT_NAMES.map((name) => `${name}=$(${COUNT_FIELDS[name].count}) || exit ${GIT_FAILED_EXIT}`).join('\n')}
printf '%s\\0' "$here"
${COUNT_NAMES.map((name) => `printf '${name} %s\\n' "$${name}"`).join('\n')}
set -f
for ref in $refs; do
  count=$(g rev-list --count "$ref" --not --remotes --) || exit ${GIT_FAILED_EXIT}
  printf 'branch %s %s\\n' "$count" "$ref"
done
if ! g symbolic-ref -q HEAD > /dev/null; then
  count=$(g rev-list --count HEAD --not --remotes --) || exit ${GIT_FAILED_EXIT}
  printf 'detached %s\\n' "$count"
fi`;

export async function runWorkspaceCheck(request: WorkspaceCheckRequest): Promise<WorkspaceCheck> {
  let run: CommandResult;

  try {
    run = await request.provider.runCommand({
      argv: [
        ...REPOSITORY_ENV_UNSET_ARGV,
        'sh',
        '-c',
        WORKSPACE_CHECK_SCRIPT,
        'sh',
        trimTrailingSlashes(posix.normalize(request.directory)),
        request.sha,
      ],
      cwd: '/',
      ...(request.host === null ? {} : { host: request.host }),
    });
  } catch {
    return { kind: 'unchecked', reason: 'host did not answer' };
  }

  return match(run.exitCode)
    .returnType<WorkspaceCheck>()
    .with(0, () => parseCheckOutput(run.stdout))
    .with(MISSING_EXIT, () => ({ kind: 'missing' }))
    .with(FOREIGN_EXIT, () => ({ kind: 'foreign' }))
    .otherwise(() => ({
      kind: 'unchecked',
      reason: `git failed: ${run.stderr.trim().split('\n')[0] ?? ''}`,
    }));
}

function buildLineCount(gitArgs: string, pattern: string): string {
  return `out=$(g ${gitArgs}) || exit ${GIT_FAILED_EXIT}; printf '%s' "$out" | grep -c -- '${pattern}' || true`;
}

function trimTrailingSlashes(directory: string): string {
  return directory.length > 1 && directory.endsWith('/')
    ? trimTrailingSlashes(directory.slice(0, -1))
    : directory;
}

const COUNT = z.number().int().nonnegative();
const BRANCH_COUNT = z.object({ name: z.string().min(1), count: COUNT });

const CHECK_OUTPUT_SCHEMA = z.object({
  counts: z.record(z.enum(COUNT_NAMES), COUNT),
  branches: z.array(BRANCH_COUNT),
  detached: COUNT.nullable(),
});

const CHECK_LINE = /^(?<name>[a-z]+) (?<count>\d+)(?: refs\/heads\/(?<branch>.+))?$/u;

function parseCheckOutput(stdout: string): WorkspaceCheck {
  const split = stdout.indexOf('\0');

  if (split < 1) {
    return { kind: 'unchecked', reason: 'the check printed no folder' };
  }

  const counts: Record<string, number> = {};
  const branches: { readonly name: string; readonly count: number }[] = [];
  let detached: number | null = null;

  for (const line of stdout
    .slice(split + 1)
    .split('\n')
    .filter((printed) => printed !== '')) {
    const groups = CHECK_LINE.exec(line)?.groups;
    const name = groups?.['name'];
    const printedCount = groups?.['count'];
    const branch = groups?.['branch'];

    if (name === undefined || printedCount === undefined) {
      return { kind: 'unchecked', reason: `the check printed an unknown line: ${line}` };
    }

    const count = Number(printedCount);

    if (name === 'branch' && branch !== undefined) {
      branches.push({ name: branch, count });
    } else if (name === 'detached' && branch === undefined && detached === null) {
      detached = count;
    } else if (branch === undefined && !Object.hasOwn(counts, name)) {
      counts[name] = count;
    } else {
      return { kind: 'unchecked', reason: `the check printed an unknown line: ${line}` };
    }
  }

  const parsed = CHECK_OUTPUT_SCHEMA.safeParse({ counts, branches, detached });

  if (!parsed.success) {
    return {
      kind: 'unchecked',
      reason: `the check printed an unknown answer: ${parsed.error.issues.map((issue) => `${issue.message} at ${issue.path.join('.')}`).join('; ')}`,
    };
  }

  const findings = [
    ...COUNT_NAMES.map((name) => formatCount(parsed.data.counts[name], COUNT_FIELDS[name])),
    ...parsed.data.branches.map((held) =>
      formatCount(held.count, {
        singular: `unpushed commit on ${held.name}`,
        plural: `unpushed commits on ${held.name}`,
      }),
    ),
    formatCount(parsed.data.detached ?? 0, {
      singular: 'unpushed commit on a detached HEAD',
      plural: 'unpushed commits on a detached HEAD',
    }),
  ];

  return {
    kind: 'checked',
    path: stdout.slice(0, split),
    findings: findings.filter((finding) => finding !== null),
  };
}

function formatCount(count: number, nouns: Pick<CountField, 'singular' | 'plural'>): string | null {
  return count === 0 ? null : `${count} ${count === 1 ? nouns.singular : nouns.plural}`;
}
