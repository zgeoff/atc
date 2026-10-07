import { expect, test } from 'bun:test';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { readWorkspaceTar } from './read-workspace-tar';

test('it streams a tar that unpacks to the same checkout and commit', async () => {
  await using fixture = await createGitFixture();

  const unpacked = join(fixture.dir, 'unpacked');

  await mkdir(unpacked);

  const tar = readWorkspaceTar(fixture.work);

  await Bun.write(join(fixture.dir, 'workspace.tar'), new Response(tar.stream));

  const outcome = await tar.done;

  await $`tar -x -f ${join(fixture.dir, 'workspace.tar')} -C ${unpacked}`.env(fixture.env).quiet();

  const unpackedHead = await $`git rev-parse HEAD`.env(fixture.env).cwd(unpacked).text();
  const readme = await readFile(join(unpacked, 'README.md'), 'utf8');

  expect(outcome).toStrictEqual({ ok: true });
  expect(unpackedHead.trim()).toBe(fixture.sha);
  expect(readme).toBe('hello\n');
});

test('it reports a directory tar cannot read', async () => {
  await using fixture = await createGitFixture();

  const tar = readWorkspaceTar(join(fixture.dir, 'missing'));

  await new Response(tar.stream).arrayBuffer();

  const outcome = await tar.done;

  expect(outcome).toStrictEqual({
    ok: false,
    code: 'tar_failed',
    message: expect.toInclude(join(fixture.dir, 'missing')),
  });
});

// TAR_OPTIONS reaches tar through the environment a process starts with, so
// these tests archive from a child process that starts with it set.
test('it archives a tracked symlink as a link when the host asks tar to dereference', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.dir, 'outside.txt'), 'atc-outside-marker-7f3a\n');
  await symlink(join(fixture.dir, 'outside.txt'), join(fixture.work, 'link'));

  await $`git add link`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git commit --quiet -m link`.env(fixture.env).cwd(fixture.work).quiet();

  await writeFile(
    join(fixture.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(fixture.work)});\nawait Bun.write(${JSON.stringify(join(fixture.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(fixture.dir, 'archive.ts')}`
    .env({ ...fixture.env, TAR_OPTIONS: '--dereference' })
    .text();

  const unpacked = join(fixture.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(fixture.dir, 'workspace.tar')} -C ${unpacked}`.env(fixture.env).quiet();

  const link = await lstat(join(unpacked, 'link'));
  const archive = await readFile(join(fixture.dir, 'workspace.tar'), 'latin1');

  expect(outcome).toBe('{"ok":true}\n');
  expect(link.isSymbolicLink()).toBeTrue();
  expect(archive).not.toInclude('atc-outside-marker-7f3a');
});

test('it archives every tracked file when the host asks tar to exclude some', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, 'notes.txt'), 'kept\n');

  await $`git add notes.txt`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git commit --quiet -m notes`.env(fixture.env).cwd(fixture.work).quiet();

  await writeFile(
    join(fixture.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(fixture.work)});\nawait Bun.write(${JSON.stringify(join(fixture.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(fixture.dir, 'archive.ts')}`
    .env({ ...fixture.env, TAR_OPTIONS: '--exclude=*.txt' })
    .text();

  const unpacked = join(fixture.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(fixture.dir, 'workspace.tar')} -C ${unpacked}`.env(fixture.env).quiet();

  const notes = await readFile(join(unpacked, 'notes.txt'), 'utf8');

  expect(outcome).toBe('{"ok":true}\n');
  expect(notes).toBe('kept\n');
});
