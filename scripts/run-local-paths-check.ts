import { hostname } from 'node:os';
import { formatCommitLines } from './format-commit-lines.ts';
import { parseAddedLines } from './parse-added-lines.ts';
import type { MergeBlobsReadings } from './pick-merge-blobs-command.ts';
import { pickMergeBlobsCommand } from './pick-merge-blobs-command.ts';
import { readPushedRanges } from './read-pushed-ranges.ts';
import { readPushedRefsInput } from './read-pushed-refs-input.ts';
import type { CommitRange } from './read-range-commits.ts';
import { readRangeCommits } from './read-range-commits.ts';
import type { RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

export interface LocalPathsCheckOptions {
  readonly cwd: string;

  readonly ranges: readonly CommitRange[];

  readonly env: Readonly<Record<string, string | undefined>>;

  readonly host: string;

  readonly runProgram: RunProgram;
}

export interface LocalPathFinding {
  // Relative to the repo root.
  readonly path: string;

  // The line's number in the file as the commit that adds it leaves it.
  readonly line: number;

  readonly message: string;
}

// Every commit is read, because a later commit that removes the line still pushes the one that adds
// it.
export function runLocalPathsCheck(options: Readonly<LocalPathsCheckOptions>): LocalPathFinding[] {
  const home = findHomePrefix(options.env['HOME']);
  const host = findHostPattern(options.host);

  if (home === null && host === null) {
    return [];
  }

  const commits = readRangeCommits(options, options.ranges);

  // git log reads HEAD when stdin names no commit.
  if (commits.length === 0) {
    return [];
  }

  runMergeBlobsFetch(options, commits);

  const result = options.runProgram(
    [
      'git',
      '-c',
      'core.quotePath=false',
      'log',
      '-p',
      '-U0',
      '-M',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',

      // A merge shows the lines its author adds beyond git's own merge, such as a conflict's
      // resolution; the lines it brings from either parent come from commits the log reads anyway.
      '--diff-merges=remerge',
      '--format=%x00%h',
      '--no-walk=unsorted',
      '--stdin',
    ],
    { cwd: options.cwd, env: options.env, stdin: formatCommitLines(commits) },
  );

  if (result.exitCode !== 0) {
    throw new Error(`git log failed: ${result.stderr.trim()}`);
  }

  return parseAddedLines(result.stdout).flatMap((added) => {
    const findings: LocalPathFinding[] = [];

    if (home !== null && added.text.includes(home)) {
      findings.push({
        path: added.path,
        line: added.line,
        message: `commit ${added.hash} adds the home directory ${home}; remove it before you push`,
      });
    }

    if (host !== null && host.pattern.test(added.text)) {
      findings.push({
        path: added.path,
        line: added.line,
        message: `commit ${added.hash} adds the host name ${host.name}; remove it before you push`,
      });
    }

    return findings;
  });
}

// A trailing slash keeps `/home/ada` from matching `/home/adam`, and a home of `/` would match
// every URL.
function findHomePrefix(home: string | undefined): string | null {
  const trimmed = home?.replace(/\/+$/u, '') ?? '';

  return trimmed === '' ? null : `${trimmed}/`;
}

// A whole word, as `grep -w` reads one. `localhost` is in every repo's configs.
function findHostPattern(name: string): { name: string; pattern: RegExp } | null {
  if (name === '' || name === 'localhost') {
    return null;
  }

  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

  return { name, pattern: new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'u') };
}

function runMergeBlobsFetch(
  options: Readonly<LocalPathsCheckOptions>,
  commits: readonly string[],
): void {
  let readings: MergeBlobsReadings = { commits, bases: [] };

  for (
    let command = pickMergeBlobsCommand(readings);
    command !== null;
    command = pickMergeBlobsCommand(readings)
  ) {
    const result = options.runProgram(command.argv, {
      cwd: options.cwd,
      env: options.env,
      ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
    });

    if (command.exitCodes !== 'any' && !command.exitCodes.includes(result.exitCode)) {
      throw new Error(`${command.argv.join(' ')} failed: ${result.stderr.trim()}`);
    }

    readings =
      command.reading === 'bases'
        ? { ...readings, bases: [...readings.bases, result.stdout] }
        : { ...readings, [command.reading]: result.stdout };
  }
}

// Returns the exit code: 0 when clean, 1 with a finding, and 2 when the check cannot run.
export async function runLocalPathsCommand(args: readonly string[]): Promise<number> {
  try {
    const ranges = readPushedRanges({
      cwd: process.cwd(),
      env: process.env,
      pushedRefs: await readPushedRefsInput(args, () => Bun.stdin.text()),
      runProgram,
    });

    const findings = runLocalPathsCheck({
      cwd: process.cwd(),
      ranges,
      env: process.env,
      host: hostname(),
      runProgram,
    });

    for (const finding of findings) {
      process.stdout.write(`${finding.path}:${finding.line}: ${finding.message}\n`);
    }

    return findings.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `local-paths: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runLocalPathsCommand(process.argv.slice(2));
}
