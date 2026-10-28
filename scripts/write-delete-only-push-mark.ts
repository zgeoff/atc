import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface WriteDeleteOnlyPushMarkOptions {
  readonly cwd: string;

  // git writes one `<local ref> <local sha> <remote ref> <remote sha>` line per ref to the
  // pre-push hook's stdin.
  readonly refs: string;

  // The process id of the lefthook run, which a concurrent push in the same worktree does not share.
  readonly hookID: string;

  readonly env?: Readonly<Record<string, string | undefined>>;
}

// lefthook runs a skip condition with an empty stdin, so the pre-push jobs cannot read the refs
// themselves and skip on this mark instead.
export async function writeDeleteOnlyPushMark(
  options: Readonly<WriteDeleteOnlyPushMarkOptions>,
): Promise<void> {
  const mark = await readMarkPath(options);

  if (isDeleteOnlyPush(options.refs)) {
    await writeFile(mark, options.hookID);

    return;
  }

  const owner = await readFile(mark, 'utf8').catch(() => null);

  if (owner === options.hookID) {
    await rm(mark, { force: true });
  }
}

async function readMarkPath(options: Readonly<WriteDeleteOnlyPushMarkOptions>): Promise<string> {
  const subprocess = Bun.spawn(['git', 'rev-parse', '--git-path', 'atc-delete-only-push'], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git rev-parse failed: ${stderr.trim()}`);
  }

  return resolve(options.cwd, stdout.trim());
}

// git gives a deleted ref an all-zero local sha: 40 digits, or 64 in a SHA-256 repository.
function isDeleteOnlyPush(refs: string): boolean {
  const lines = refs.split('\n').filter((line) => line.trim() !== '');

  return lines.length > 0 && lines.every((line) => /^0+$/u.test(line.split(' ')[1] ?? ''));
}

async function main(): Promise<void> {
  try {
    const hookID = process.argv.at(2);

    if (hookID === undefined || hookID === '') {
      throw new Error('pass the process id of the lefthook run as the first argument');
    }

    // A hook run by hand gives the job the terminal as stdin, and a read would wait on it.
    const refs = process.stdin.isTTY ? '' : await Bun.stdin.text();

    await writeDeleteOnlyPushMark({ cwd: resolve('.'), refs, hookID });
  } catch (error) {
    process.stderr.write(
      `write-delete-only-push-mark: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
