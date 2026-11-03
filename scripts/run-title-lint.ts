import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface TitleLint {
  readonly title: string;

  // The checkout, whose root catalog pins commitlint and whose commitlint.config.js holds the rules.
  readonly repoRoot: string;

  // A folder outside the checkout, so the install never reads the workspace.
  readonly installFolder: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// The job installs commitlint alone, never the whole workspace. The checkout's bunfig.toml goes
// with it, because `bun add` keeps its release-age gate and `bun x` ignores it. The title reaches
// commitlint on stdin, never through the shell, so a crafted title cannot inject a command.
export async function runTitleLint(lint: TitleLint): Promise<number> {
  const manifestText = await Bun.file(join(lint.repoRoot, 'package.json')).text();

  const version = parseCommitlintVersion(manifestText);

  await mkdir(lint.installFolder, { recursive: true });
  await writeFile(join(lint.installFolder, 'package.json'), '{ "private": true }\n');
  await copyFile(join(lint.repoRoot, 'bunfig.toml'), join(lint.installFolder, 'bunfig.toml'));

  const installing = Bun.spawn(['bun', 'add', '--exact', `@commitlint/cli@${version}`], {
    cwd: lint.installFolder,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...lint.env },
  });

  const installExitCode = await installing.exited;

  if (installExitCode !== 0) {
    return installExitCode;
  }

  const linting = Bun.spawn(
    [join(lint.installFolder, 'node_modules/.bin/commitlint'), '--verbose'],
    {
      cwd: lint.repoRoot,
      stdin: new Response(`${lint.title}\n`),
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...lint.env },
    },
  );

  return linting.exited;
}

function parseCommitlintVersion(manifestText: string): string {
  const manifest: unknown = JSON.parse(manifestText);
  const workspaces = isRecord(manifest) ? manifest['workspaces'] : undefined;
  const catalog = isRecord(workspaces) ? workspaces['catalog'] : undefined;
  const version = isRecord(catalog) ? catalog['@commitlint/cli'] : undefined;

  if (typeof version !== 'string') {
    throw new TypeError('the root catalog has no version of @commitlint/cli');
  }

  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

if (import.meta.main) {
  const runnerTemp = process.env['RUNNER_TEMP'] ?? '';

  if (runnerTemp === '') {
    process.stderr.write('title-lint: RUNNER_TEMP names no folder to install commitlint in\n');
    process.exit(2);
  }

  const exitCode = await runTitleLint({
    title: process.env['TITLE'] ?? '',
    repoRoot: join(import.meta.dir, '..'),
    installFolder: join(runnerTemp, 'title-lint'),
    env: process.env,
  });

  process.exit(exitCode);
}
