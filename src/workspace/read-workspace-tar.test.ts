import { expect, test } from 'bun:test';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { readWorkspaceTar } from './read-workspace-tar';

// A work clone holding one commit, for the archive to stream.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-tar-' });

  return {
    dir: fixture.dir,
    env: fixture.env,
    upstream: fixture.upstream,
    work: fixture.work,
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}

test('it streams a tar that unpacks to the same checkout and commit', async () => {
  await using ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const unpacked = join(ctx.dir, 'unpacked');

  await mkdir(unpacked);

  const tar = readWorkspaceTar(ctx.work);

  await Bun.write(join(ctx.dir, 'workspace.tar'), new Response(tar.stream));

  const outcome = await tar.done;

  await $`tar -x -f ${join(ctx.dir, 'workspace.tar')} -C ${unpacked}`.env(ctx.env).quiet();

  const unpackedHead = await $`git rev-parse HEAD`.env(ctx.env).cwd(unpacked).text();
  const readme = await readFile(join(unpacked, 'README.md'), 'utf8');

  expect(outcome).toStrictEqual({ ok: true });
  expect(unpackedHead.trim()).toBe(pushed);
  expect(readme).toBe('hello\n');
});

test('it reports a directory tar cannot read', async () => {
  await using ctx = await setupTest();

  const tar = readWorkspaceTar(join(ctx.dir, 'missing'));

  await new Response(tar.stream).arrayBuffer();

  const outcome = await tar.done;

  expect(outcome).toStrictEqual({
    ok: false,
    code: 'tar_failed',
    message: expect.toInclude(join(ctx.dir, 'missing')),
  });
});

// TAR_OPTIONS reaches tar through the environment a process starts with, so
// these tests archive from a child process that starts with it set.
test('it archives a tracked symlink as a link when the host asks tar to dereference', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.dir, 'outside.txt'), 'atc-outside-marker-7f3a\n');
  await symlink(join(ctx.dir, 'outside.txt'), join(ctx.work, 'link'));

  await $`git add link`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m link`.env(ctx.env).cwd(ctx.work).quiet();

  await writeFile(
    join(ctx.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(ctx.work)});\nawait Bun.write(${JSON.stringify(join(ctx.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(ctx.dir, 'archive.ts')}`
    .env({ ...ctx.env, TAR_OPTIONS: '--dereference' })
    .text();

  const unpacked = join(ctx.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(ctx.dir, 'workspace.tar')} -C ${unpacked}`.env(ctx.env).quiet();

  const link = await lstat(join(unpacked, 'link'));
  const archive = await readFile(join(ctx.dir, 'workspace.tar'), 'latin1');

  expect(outcome).toBe('{"ok":true}\n');
  expect(link.isSymbolicLink()).toBeTrue();
  expect(archive).not.toInclude('atc-outside-marker-7f3a');
});

test('it archives every tracked file when the host asks tar to exclude some', async () => {
  await using ctx = await setupTest();

  await writeFile(join(ctx.work, 'notes.txt'), 'kept\n');

  await $`git add notes.txt`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m notes`.env(ctx.env).cwd(ctx.work).quiet();

  await writeFile(
    join(ctx.dir, 'archive.ts'),
    `import { readWorkspaceTar } from ${JSON.stringify(join(import.meta.dir, 'read-workspace-tar.ts'))};\nconst tar = readWorkspaceTar(${JSON.stringify(ctx.work)});\nawait Bun.write(${JSON.stringify(join(ctx.dir, 'workspace.tar'))}, new Response(tar.stream));\nconsole.log(JSON.stringify(await tar.done));\n`,
  );

  const outcome = await $`${process.execPath} ${join(ctx.dir, 'archive.ts')}`
    .env({ ...ctx.env, TAR_OPTIONS: '--exclude=*.txt' })
    .text();

  const unpacked = join(ctx.dir, 'unpacked');

  await mkdir(unpacked);

  await $`tar -x -f ${join(ctx.dir, 'workspace.tar')} -C ${unpacked}`.env(ctx.env).quiet();

  const notes = await readFile(join(unpacked, 'notes.txt'), 'utf8');

  expect(outcome).toBe('{"ok":true}\n');
  expect(notes).toBe('kept\n');
});
