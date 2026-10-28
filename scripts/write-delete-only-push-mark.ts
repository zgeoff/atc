import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface WriteDeleteOnlyPushMarkOptions {
  readonly cwd: string;

  // git writes one `<local ref> <local sha> <remote ref> <remote sha>` line per ref to the
  // pre-push hook's stdin.
  readonly refs: string;

  // The process id of the lefthook run, which a concurrent push in the same worktree does not share.
  readonly hookID: number;

  readonly env?: Readonly<Record<string, string | undefined>>;
}

// lefthook runs a skip condition with an empty stdin, so the pre-push jobs cannot read the refs
// themselves and skip on this mark instead.
export async function writeDeleteOnlyPushMark(
  options: Readonly<WriteDeleteOnlyPushMarkOptions>,
): Promise<void> {
  const marks = await readMarksPath(options);

  const mark = join(marks, String(options.hookID));

  await mkdir(marks, { recursive: true });
  await (isDeleteOnlyPush(options.refs) ? writeFile(mark, '') : rm(mark, { force: true }));
  await removeEndedRunMarks(marks, options.hookID);
}

async function readMarksPath(options: Readonly<WriteDeleteOnlyPushMarkOptions>): Promise<string> {
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

// A run that ended leaves its mark behind, and a later run that takes the same pid removes or
// rewrites its own mark first, so only the marks of ended runs need sweeping.
async function removeEndedRunMarks(marks: string, hookID: number): Promise<void> {
  const names = await readdir(marks);

  const ended = names.filter((name) => name !== String(hookID) && !probeProcess(Number(name)));

  await Promise.all(ended.map((name) => rm(join(marks, name), { force: true })));
}

function probeProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means the process runs under another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function main(): Promise<void> {
  try {
    const argument = process.argv.at(2) ?? '';

    if (!/^[1-9]\d*$/u.test(argument)) {
      throw new Error('pass the process id of the lefthook run as the first argument');
    }

    // A hook run by hand gives the job the terminal as stdin, and a read would wait on it.
    const refs = process.stdin.isTTY ? '' : await Bun.stdin.text();

    await writeDeleteOnlyPushMark({ cwd: resolve('.'), refs, hookID: Number(argument) });
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
