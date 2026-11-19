import { posix } from 'node:path';
import type { CommandResult, ExecutionProvider } from '@atc/plugin-api';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { REPOSITORY_ENV_UNSET_ARGV } from '../workspace/repository-env-unset-argv';

export type WorkspaceCheck =
  | { readonly kind: 'checked'; readonly path: string; readonly findings: readonly string[] }
  | { readonly kind: 'unchecked'; readonly reason: string }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'missing' };

interface WorkspaceCheckRequest {
  readonly provider: Pick<ExecutionProvider, 'runCommand'>;

  readonly host: string | null;
  readonly directory: string;

  readonly sha: string;
}

const MISSING_EXIT = 80;
const FOREIGN_EXIT = 81;
const GIT_FAILED_EXIT = 82;

type FieldLines = 'one' | 'optional' | 'per-ref';

interface CountNouns {
  readonly singular: string;
  readonly plural: string;
}

interface CheckField {
  readonly print: (label: string) => string;
  readonly lines: FieldLines;
  readonly describe: (ref: string | null) => CountNouns;
}

const FIELD_NAMES = [
  'changes',
  'hidden',
  'stashes',
  'worktrees',
  'submodules',
  'branch',
  'tag',
  'notes',
  'detached',
] as const;

// git status omits paths hidden by a submodule ignore setting or an assume-unchanged or
// skip-worktree flag. No git check sees inside a linked worktree or a submodule, so each counts
// as work.
const CHECK_FIELDS: Readonly<Record<(typeof FIELD_NAMES)[number], CheckField>> = {
  changes: buildCountField(
    buildLineCount('status --porcelain --untracked-files=all --ignore-submodules=none', '^'),
    'uncommitted or untracked path',
    'uncommitted or untracked paths',
  ),
  hidden: buildCountField(
    buildLineCount('ls-files -v', '^[a-zS] '),
    'path hidden from git status',
    'paths hidden from git status',
  ),
  stashes: buildCountField(buildLineCount('stash list', '^'), 'stash', 'stashes'),
  worktrees: buildCountField(
    `out=$(g worktree list --porcelain) || exit ${GIT_FAILED_EXIT}; all=$(printf '%s' "$out" | grep -c '^worktree '); stale=$(printf '%s' "$out" | grep -c '^prunable'); echo $((all - 1 - stale))`,
    'linked worktree',
    'linked worktrees',
  ),
  submodules: buildCountField(
    buildLineCount('ls-files --stage', '^160000 '),
    'submodule',
    'submodules',
  ),
  branch: buildRefField('refs/heads', (ref) => ({
    singular: `unpushed commit on ${ref}`,
    plural: `unpushed commits on ${ref}`,
  })),

  tag: buildRefField('refs/tags', (ref) => ({
    singular: `unpushed commit on tag ${ref}`,
    plural: `unpushed commits on tag ${ref}`,
  })),
  notes: buildRefField('refs/notes', (ref) => ({
    singular: `unpushed commit on notes ref ${ref}`,
    plural: `unpushed commits on notes ref ${ref}`,
  })),
  detached: {
    print: (label) => `if ! g symbolic-ref -q HEAD > /dev/null; then
  count=$(g rev-list --count HEAD --not --remotes --) || exit ${GIT_FAILED_EXIT}
  printf '${label} %s\\n' "$count"
fi`,
    lines: 'optional',
    describe: () => ({
      singular: 'unpushed commit on a detached HEAD',
      plural: 'unpushed commits on a detached HEAD',
    }),
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
printf '%s\\0' "$here"
${FIELD_NAMES.map((name) => CHECK_FIELDS[name].print(name)).join('\n')}`;

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

function buildCountField(count: string, singular: string, plural: string): CheckField {
  return {
    print: (label) =>
      `count=$(${count}) || exit ${GIT_FAILED_EXIT}\nprintf '${label} %s\\n' "$count"`,
    lines: 'one',
    describe: () => ({ singular, plural }),
  };
}

function buildLineCount(gitArgs: string, pattern: string): string {
  return `out=$(g ${gitArgs}) || exit ${GIT_FAILED_EXIT}; printf '%s' "$out" | grep -c -- '${pattern}' || true`;
}

// git rev-list counts no commits for a ref that points at a tree or a blob, so such a ref would
// look clean. The script fails the check instead.
function buildRefField(prefix: string, describe: (ref: string) => CountNouns): CheckField {
  return {
    print: (
      label,
    ) => `refs=$(g for-each-ref --format='%(refname)' ${prefix}) || exit ${GIT_FAILED_EXIT}
set -f
for ref in $refs; do
  g rev-parse --quiet --verify "$ref^{commit}" > /dev/null || exit ${GIT_FAILED_EXIT}
  count=$(g rev-list --count "$ref" --not --remotes --) || exit ${GIT_FAILED_EXIT}
  printf '${label} %s %s\\n' "$count" "\${ref#${prefix}/}"
done`,
    lines: 'per-ref',
    describe: (ref) => describe(ref ?? ''),
  };
}

function trimTrailingSlashes(directory: string): string {
  return directory.length > 1 && directory.endsWith('/')
    ? trimTrailingSlashes(directory.slice(0, -1))
    : directory;
}

const FIELD_LINE = z.object({
  ref: z.string().min(1).nullable(),
  count: z.number().int().nonnegative(),
});

const FIELD_LINES_MESSAGES: Readonly<Record<FieldLines, string>> = {
  one: 'expected exactly one line',
  optional: 'expected at most one line',
  'per-ref': 'expected a ref on each line',
};

const CHECK_OUTPUT_SCHEMA = z
  .record(z.enum(FIELD_NAMES), z.array(FIELD_LINE))
  .superRefine((answer, ctx) => {
    for (const name of FIELD_NAMES) {
      const expected = CHECK_FIELDS[name].lines;

      if (!hasFieldLines(expected, answer[name])) {
        ctx.addIssue({ code: 'custom', message: FIELD_LINES_MESSAGES[expected], path: [name] });
      }
    }
  });

const CHECK_LINE = /^(?<label>[a-z]+) (?<count>\d+)(?: (?<ref>.+))?$/u;

function parseCheckOutput(stdout: string): WorkspaceCheck {
  const split = stdout.indexOf('\0');

  if (split < 1) {
    return { kind: 'unchecked', reason: 'the check printed no folder' };
  }

  const printed = new Map<string, { readonly ref: string | null; readonly count: number }[]>(
    FIELD_NAMES.map((name) => [name, []]),
  );

  for (const line of stdout
    .slice(split + 1)
    .split('\n')
    .filter((text) => text !== '')) {
    const groups = CHECK_LINE.exec(line)?.groups;
    const label = groups?.['label'];
    const count = groups?.['count'];

    if (label === undefined || count === undefined) {
      return { kind: 'unchecked', reason: `the check printed an unknown line: ${line}` };
    }

    printed.set(label, [
      ...(printed.get(label) ?? []),
      { ref: groups?.['ref'] ?? null, count: Number(count) },
    ]);
  }

  const parsed = CHECK_OUTPUT_SCHEMA.safeParse(Object.fromEntries(printed));

  if (!parsed.success) {
    return {
      kind: 'unchecked',
      reason: `the check printed an unknown answer: ${parsed.error.issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.message} at ${issue.path.join('.')}`)).join('; ')}`,
    };
  }

  const findings = FIELD_NAMES.flatMap((name) =>
    parsed.data[name].map((entry) =>
      formatCount(entry.count, CHECK_FIELDS[name].describe(entry.ref)),
    ),
  );

  return {
    kind: 'checked',
    path: stdout.slice(0, split),
    findings: findings.filter((finding) => finding !== null),
  };
}

function hasFieldLines(
  expected: FieldLines,
  lines: readonly { readonly ref: string | null }[],
): boolean {
  return match(expected)
    .with('one', () => lines.length === 1 && lines.every((line) => line.ref === null))
    .with('optional', () => lines.length <= 1 && lines.every((line) => line.ref === null))
    .with('per-ref', () => lines.every((line) => line.ref !== null))
    .exhaustive();
}

function formatCount(count: number, nouns: CountNouns): string | null {
  return count === 0 ? null : `${count} ${count === 1 ? nouns.singular : nouns.plural}`;
}
