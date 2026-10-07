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
  await using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'src'));
  writeFileSync(join(ctx.dir, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(ctx.dir, 'src')} .`.arrayBuffer();

  const provider = new FixtureDirProvider();

  await provider.transferArchive(new Uint8Array(archive), join(ctx.dir, 'host', 'ws'));

  expect(readFileSync(join(ctx.dir, 'host', 'ws', 'hello.txt'), 'utf8')).toBe('hello\n');

  expect(provider.calls).toStrictEqual([
    { op: 'transfer', dir: join(ctx.dir, 'host', 'ws'), bytes: archive.byteLength },
  ]);
});

test('it runs a command in its working directory and records it', async () => {
  await using ctx = setupTest();

  const provider = new FixtureDirProvider();

  const result = await provider.runCommand({ argv: ['pwd'], cwd: ctx.dir });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${ctx.dir}\n`, stderr: '' });
  expect(provider.calls).toStrictEqual([{ op: 'run', argv: ['pwd'], cwd: ctx.dir }]);
});

test('it runs the after-transfer step on the unpacked directory before the transfer resolves', async () => {
  await using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'src'));
  writeFileSync(join(ctx.dir, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(ctx.dir, 'src')} .`.arrayBuffer();

  const provider = new FixtureDirProvider({
    afterTransfer: async (dir) => {
      await Bun.write(join(dir, 'hello.txt'), 'changed\n');
    },
  });

  await provider.transferArchive(new Uint8Array(archive), join(ctx.dir, 'ws'));

  expect(readFileSync(join(ctx.dir, 'ws', 'hello.txt'), 'utf8')).toBe('changed\n');
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

test('it rejects an archive tar cannot unpack', () => {
  using ctx = setupTest();

  const provider = new FixtureDirProvider();

  const transfer = provider.transferArchive(new Uint8Array([1, 2, 3]), join(ctx.dir, 'ws'));

  expect(transfer).rejects.toThrowWithMessage(
    Error,
    new RegExp(`^tar exited [1-9]\\d* unpacking into ${join(ctx.dir, 'ws')}: \\S`),
  );
});

test('it refuses to suspend a host', () => {
  const provider = new FixtureDirProvider();

  expect(provider.suspendHost('h1')).rejects.toThrowWithMessage(
    Error,
    'the fixture-dir provider cannot suspend host h1',
  );
});

test('it refuses to destroy a host', () => {
  const provider = new FixtureDirProvider();

  expect(provider.destroyHost('h1')).rejects.toThrowWithMessage(
    Error,
    'the fixture-dir provider cannot destroy host h1',
  );
});

test('it starts a harness on a local terminal and records its spec', async () => {
  await using ctx = setupTest();

  const provider = new FixtureDirProvider();

  const spec = {
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: ctx.dir,
    env: { A: '1' },
    cols: 80,
    rows: 24,
  };

  const exited = Promise.withResolvers<number>();

  provider.spawnHarness(spec).onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  const exitCode = await exited.promise;

  expect(provider.harnesses).toStrictEqual([spec]);
  expect(exitCode).toBe(0);
});
