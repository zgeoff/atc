import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { readWorkspaceTar } from './read-workspace-tar';

async function setupTest() {
  // A git hook exports GIT_DIR and friends, which would point these
  // commands at the repository running the hook instead of the temp tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  const dir = await mkdtemp(join(tmpdir(), 'atc-tar-'));

  const work = join(dir, 'work');

  await $`git init --quiet --template= --initial-branch=main ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();

  return {
    env,
    dir,
    work,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it streams a tar that unpacks to the same checkout and commit', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.work).text();

  const unpacked = join(project.dir, 'unpacked');

  await mkdir(unpacked);

  const tar = readWorkspaceTar(project.work);

  await Bun.write(join(project.dir, 'workspace.tar'), new Response(tar.stream));

  const outcome = await tar.done;

  await $`tar -x -f ${join(project.dir, 'workspace.tar')} -C ${unpacked}`.env(project.env).quiet();

  const unpackedHead = await $`git rev-parse HEAD`.env(project.env).cwd(unpacked).text();
  const readme = await readFile(join(unpacked, 'README.md'), 'utf8');

  expect(outcome).toStrictEqual({ ok: true });
  expect(unpackedHead.trim()).toBe(head.trim());
  expect(readme).toBe('hello\n');
});

test('it reports a directory tar cannot read', async () => {
  await using project = await setupTest();

  const tar = readWorkspaceTar(join(project.dir, 'missing'));

  await new Response(tar.stream).arrayBuffer();

  const outcome = await tar.done;

  expect(outcome).toMatchObject({ ok: false, code: 'tar_failed' });
});

// TAR_OPTIONS reaches tar through the environment a process starts with, so
// these tests archive from a child process that starts with it set.
test('it archives a tracked symlink as a link when the host asks tar to dereference', async () => {
  await using project = await setupTest();

  await writeFile(join(project.dir, 'outside.txt'), 'atc-outside-marker-7f3a\n');
  await symlink(join(project.dir, 'outside.txt'), join(project.work, 'link'));

  await $`git add link`.env(project.env).cwd(project.work).quiet();
  await $`git commit --quiet -m link`.env(project.env).cwd(project.work).quiet();

  await writeFile(
    join(project.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(project.work)});\nawait Bun.write(${JSON.stringify(join(project.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(project.dir, 'archive.ts')}`
    .env({ ...project.env, TAR_OPTIONS: '--dereference' })
    .text();

  const unpacked = join(project.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(project.dir, 'workspace.tar')} -C ${unpacked}`.env(project.env).quiet();

  const link = await lstat(join(unpacked, 'link'));
  const archive = await readFile(join(project.dir, 'workspace.tar'));

  expect(outcome).toBe('{"ok":true}\n');
  expect(link.isSymbolicLink()).toBeTrue();
  expect(archive.includes('atc-outside-marker-7f3a')).toBeFalse();
});

test('it archives every tracked file when the host asks tar to exclude some', async () => {
  await using project = await setupTest();

  await writeFile(join(project.work, 'notes.txt'), 'kept\n');

  await $`git add notes.txt`.env(project.env).cwd(project.work).quiet();
  await $`git commit --quiet -m notes`.env(project.env).cwd(project.work).quiet();

  await writeFile(
    join(project.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(project.work)});\nawait Bun.write(${JSON.stringify(join(project.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(project.dir, 'archive.ts')}`
    .env({ ...project.env, TAR_OPTIONS: '--exclude=*.txt' })
    .text();

  const unpacked = join(project.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(project.dir, 'workspace.tar')} -C ${unpacked}`.env(project.env).quiet();

  const notes = await readFile(join(unpacked, 'notes.txt'), 'utf8');

  expect(outcome).toBe('{"ok":true}\n');
  expect(notes).toBe('kept\n');
});
