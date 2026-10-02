import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureDirProvider } from './fixture-dir-provider';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-fixture-dir-');
}

test('it unpacks a transferred archive into the directory it is given and records it', async () => {
  await using tmp = setupTest();

  mkdirSync(join(tmp.dir, 'src'));
  writeFileSync(join(tmp.dir, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(tmp.dir, 'src')} .`.arrayBuffer();

  const provider = new FixtureDirProvider();

  await provider.transferArchive(new Uint8Array(archive), join(tmp.dir, 'host', 'ws'));

  expect(readFileSync(join(tmp.dir, 'host', 'ws', 'hello.txt'), 'utf8')).toBe('hello\n');

  expect(provider.calls).toStrictEqual([
    { op: 'transfer', dir: join(tmp.dir, 'host', 'ws'), bytes: archive.byteLength },
  ]);
});

test('it runs a command in its working directory and records it', async () => {
  await using tmp = setupTest();

  const provider = new FixtureDirProvider();

  const result = await provider.runCommand({ argv: ['pwd'], cwd: tmp.dir });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${tmp.dir}\n`, stderr: '' });
  expect(provider.calls).toStrictEqual([{ op: 'run', argv: ['pwd'], cwd: tmp.dir }]);
});

test('it runs the after-transfer step on the unpacked directory before the transfer resolves', async () => {
  await using tmp = setupTest();

  mkdirSync(join(tmp.dir, 'src'));
  writeFileSync(join(tmp.dir, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(tmp.dir, 'src')} .`.arrayBuffer();

  const provider = new FixtureDirProvider({
    afterTransfer: async (dir) => {
      await Bun.write(join(dir, 'hello.txt'), 'changed\n');
    },
  });

  await provider.transferArchive(new Uint8Array(archive), join(tmp.dir, 'ws'));

  expect(readFileSync(join(tmp.dir, 'ws', 'hello.txt'), 'utf8')).toBe('changed\n');
});

test('it declares the capabilities it is told it lacks as missing', () => {
  const provider = new FixtureDirProvider({ lacking: ['transfer', 'run'] });

  expect(provider.capabilities).toStrictEqual({
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: false,
    run: false,
    headless: false,
    suspend: false,
    destroy: false,
  });
});

test('it rejects an archive tar cannot unpack', async () => {
  await using tmp = setupTest();

  const provider = new FixtureDirProvider();

  const failure = await provider
    .transferArchive(new Uint8Array([1, 2, 3]), join(tmp.dir, 'ws'))
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(Error);
});

test('it starts a harness on a local terminal and records its spec', async () => {
  await using tmp = setupTest();

  const provider = new FixtureDirProvider();

  const spec = { bin: 'true', args: [], cwd: tmp.dir, env: { A: '1' }, cols: 80, rows: 24 };
  const exited = Promise.withResolvers<number>();

  provider.spawnHarness(spec).onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  const exitCode = await exited.promise;

  expect(provider.harnesses).toStrictEqual([spec]);
  expect(exitCode).toBe(0);
});
