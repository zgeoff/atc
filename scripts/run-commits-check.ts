import { dirname, join } from 'node:path';
import { formatCommitLines } from './format-commit-lines.ts';
import { readPushedRanges } from './read-pushed-ranges.ts';
import { readPushedRefsInput } from './read-pushed-refs-input.ts';
import type { CommitRange } from './read-range-commits.ts';
import { readRangeCommits } from './read-range-commits.ts';
import type { ProgramResult, RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

export interface CommitsCheckOptions {
  readonly cwd: string;

  readonly ranges: readonly CommitRange[];

  readonly env: Readonly<Record<string, string | undefined>>;

  readonly commitlint: string;
  readonly config: string;

  readonly runProgram: RunProgram;
}

// --config replaces any commitlint config the repo keeps, so every repo that runs the check lints
// with the same rules.
export function runCommitsCheck(options: Readonly<CommitsCheckOptions>): string[] {
  return readBranchCommits(options).flatMap((commit) => {
    const result = options.runProgram(
      [options.commitlint, '--config', options.config, '--color=false'],
      { cwd: options.cwd, env: options.env, stdin: commit.message },
    );

    return parseCommitlintOutput(commit.hash, result);
  });
}

interface Commit {
  readonly hash: string;
  readonly message: string;
}

// A merge commit carries the message git wrote, so the check leaves it out.
function readBranchCommits(options: Readonly<CommitsCheckOptions>): Commit[] {
  const commits = readRangeCommits(options, options.ranges);

  // git log reads HEAD when stdin names no commit.
  if (commits.length === 0) {
    return [];
  }

  const result = options.runProgram(
    ['git', 'log', '--no-merges', '-z', '--format=%h%n%B', '--no-walk=unsorted', '--stdin'],
    { cwd: options.cwd, env: options.env, stdin: formatCommitLines(commits) },
  );

  if (result.exitCode !== 0) {
    throw new Error(`git log failed: ${result.stderr.trim()}`);
  }

  return result.stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const newline = entry.indexOf('\n');

      return { hash: entry.slice(0, newline), message: entry.slice(newline + 1) };
    });
}

function parseCommitlintOutput(hash: string, result: ProgramResult): string[] {
  // The default formatter: `✖   subject may not be empty [subject-empty]`. The summary line,
  // `✖   found 1 problems, 0 warnings`, ends with no rule name.
  const problemLine = /^✖\s+(?<message>.+ \[[\w-]+\])$/u;

  // commitlint exits 1 when it reports a problem, and with other codes when it cannot run, such as
  // 9 for a config with no rules.
  if (result.exitCode > 1) {
    throw new Error(`commitlint failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const problems = result.stdout.split('\n').flatMap((line) => {
    const message = problemLine.exec(line)?.groups?.['message'];

    return message === undefined ? [] : [`commit ${hash}: ${message}`];
  });

  // An exit of 1 with no problem it could read is a crash, such as a config it cannot load.
  if (result.exitCode === 1 && problems.length === 0) {
    throw new Error(`commitlint failed: ${result.stderr.trim()}`);
  }

  return problems;
}

// Returns the exit code: 0 when clean or skipped, 1 with a problem, and 2 when the check cannot run.
export async function runCommitsCommand(args: readonly string[]): Promise<number> {
  const cwd = process.cwd();

  const commitlint = Bun.which('commitlint', {
    PATH: `${join(cwd, 'node_modules/.bin')}:${process.env['PATH'] ?? ''}`,
  });

  if (commitlint === null) {
    writeSkipNotice(
      'the repo does not install commitlint; add @commitlint/cli and @zgeoff/commitlint-config as devDependencies to run it',
    );

    return 0;
  }

  if (!(await probeConfigInstalled(cwd))) {
    writeSkipNotice(
      'the repo does not install @zgeoff/commitlint-config; add it as a devDependency to run it',
    );

    return 0;
  }

  try {
    // An installed package that still fails to resolve, such as one whose export names a missing
    // file, is broken, so it throws here rather than skip.
    const config = Bun.resolveSync('@zgeoff/commitlint-config', cwd);

    const ranges = readPushedRanges({
      cwd,
      env: process.env,
      pushedRefs: await readPushedRefsInput(args, () => Bun.stdin.text()),
      runProgram,
    });

    const problems = runCommitsCheck({
      cwd,
      ranges,
      env: process.env,
      commitlint,
      config,
      runProgram,
    });

    for (const problem of problems) {
      process.stdout.write(`${problem}\n`);
    }

    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`commits: ${error instanceof Error ? error.message : String(error)}\n`);

    return 2;
  }
}

// Bun's resolver throws the same error for a package that is absent and for one it cannot read, so
// the check looks for the package's package.json in each node_modules that resolution walks.
async function probeConfigInstalled(cwd: string): Promise<boolean> {
  const found = await Promise.all(
    collectAncestorFolders(cwd).map((folder) =>
      Bun.file(join(folder, 'node_modules/@zgeoff/commitlint-config/package.json')).exists(),
    ),
  );

  return found.includes(true);
}

function collectAncestorFolders(folder: string): string[] {
  const parent = dirname(folder);

  return parent === folder ? [folder] : [folder, ...collectAncestorFolders(parent)];
}

function writeSkipNotice(reason: string): void {
  // GitHub Actions shows a line that starts with ::notice:: on the run's summary.
  const prefix = process.env['GITHUB_ACTIONS'] === 'true' ? '::notice::' : '';

  process.stdout.write(`${prefix}commits: skipped, because ${reason}\n`);
}

if (import.meta.main) {
  process.exitCode = await runCommitsCommand(process.argv.slice(2));
}
