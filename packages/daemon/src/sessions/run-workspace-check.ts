import type { CommandResult, ExecutionProvider } from '@atc/plugin-api';
import { P, match } from 'ts-pattern';
import { REPOSITORY_ENV_UNSET_ARGV } from '../workspace/repository-env-unset-argv';

// `foreign` is a folder that is not the top of a git checkout holding the workspace's commit.
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

// git status starts an fsmonitor that the repository's own config names, and skips what a
// submodule's ignore setting hides, so the script overrides both; a linked worktree or a
// submodule counts as work, since no other check sees inside one
export const WORKSPACE_CHECK_SCRIPT = `dir=$1 sha=$2
if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then exit ${MISSING_EXIT}; fi
cd -P -- "$dir" || exit ${GIT_FAILED_EXIT}
here=$(pwd -P; printf x) || exit ${GIT_FAILED_EXIT}
here=\${here%?x}
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C
g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }
top=$(g rev-parse --show-toplevel) || exit ${FOREIGN_EXIT}
[ "$top" = "$here" ] || exit ${FOREIGN_EXIT}
g cat-file -e "$sha^{commit}" || exit ${FOREIGN_EXIT}
changes=$(g status --porcelain --untracked-files=all --ignore-submodules=none) || exit ${GIT_FAILED_EXIT}
stashes=$(g stash list) || exit ${GIT_FAILED_EXIT}
worktrees=$(g worktree list --porcelain) || exit ${GIT_FAILED_EXIT}
index=$(g ls-files --stage) || exit ${GIT_FAILED_EXIT}
refs=$(g for-each-ref --format='%(refname)' refs/heads) || exit ${GIT_FAILED_EXIT}
listed=$(printf '%s\\n' "$worktrees" | grep -c '^worktree ')
stale=$(printf '%s\\n' "$worktrees" | grep -c '^prunable')
printf '%s\\0' "$here"
printf 'changes %s\\n' "$(printf '%s' "$changes" | grep -c '^')"
printf 'stashes %s\\n' "$(printf '%s' "$stashes" | grep -c '^')"
printf 'worktrees %s\\n' "$((listed - 1 - stale))"
printf 'submodules %s\\n' "$(printf '%s\\n' "$index" | grep -c '^160000 ')"
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
        request.directory,
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

const CHECK_LINE =
  /^(?<kind>changes|stashes|worktrees|submodules|branch|detached) (?<count>\d+)(?: refs\/heads\/(?<branch>.+))?$/u;

function parseCheckOutput(stdout: string): WorkspaceCheck {
  const split = stdout.indexOf('\0');

  if (split < 1) {
    return { kind: 'unchecked', reason: 'the check printed no folder' };
  }

  const findings: string[] = [];
  const lines = stdout.slice(split + 1).split('\n');

  for (const line of lines.filter((printed) => printed !== '')) {
    const groups = CHECK_LINE.exec(line)?.groups;
    const nouns = groups === undefined ? null : pickCountNouns(groups);
    const count = groups?.['count'];

    if (nouns === null || count === undefined) {
      return { kind: 'unchecked', reason: `the check printed an unknown line: ${line}` };
    }

    if (count !== '0') {
      findings.push(`${count} ${count === '1' ? nouns.singular : nouns.plural}`);
    }
  }

  return { kind: 'checked', path: stdout.slice(0, split), findings };
}

function pickCountNouns(
  groups: Readonly<Record<string, string | undefined>>,
): { readonly singular: string; readonly plural: string } | null {
  return match(groups)
    .with({ kind: 'changes', branch: P.nullish }, () => ({
      singular: 'uncommitted or untracked path',
      plural: 'uncommitted or untracked paths',
    }))
    .with({ kind: 'stashes', branch: P.nullish }, () => ({ singular: 'stash', plural: 'stashes' }))
    .with({ kind: 'worktrees', branch: P.nullish }, () => ({
      singular: 'linked worktree',
      plural: 'linked worktrees',
    }))
    .with({ kind: 'submodules', branch: P.nullish }, () => ({
      singular: 'submodule',
      plural: 'submodules',
    }))
    .with({ kind: 'branch', branch: P.string }, (matched) => ({
      singular: `unpushed commit on ${matched.branch}`,
      plural: `unpushed commits on ${matched.branch}`,
    }))
    .with({ kind: 'detached', branch: P.nullish }, () => ({
      singular: 'unpushed commit on a detached HEAD',
      plural: 'unpushed commits on a detached HEAD',
    }))
    .otherwise(() => null);
}
