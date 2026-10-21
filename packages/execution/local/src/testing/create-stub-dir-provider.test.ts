import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { createStubDirProvider } from './create-stub-dir-provider';

// A temp directory the provider's transfers and commands run in.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-dir-provider-');

  return { directory: temporaryDirectory.path };
}

test('it unpacks a transferred archive into the directory it is given and records it', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'src'));
  writeFileSync(join(ctx.directory, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(ctx.directory, 'src')} .`.arrayBuffer();

  const provider = createStubDirProvider();

  await provider.transferArchive(new Uint8Array(archive), join(ctx.directory, 'host', 'ws'));

  expect(readFileSync(join(ctx.directory, 'host', 'ws', 'hello.txt'), 'utf8')).toBe('hello\n');

  expect(provider.calls).toStrictEqual([
    { op: 'transfer', directory: join(ctx.directory, 'host', 'ws'), bytes: archive.byteLength },
  ]);
});

test('it runs a command in its working directory and records it', async () => {
  const ctx = setupTest();
  const provider = createStubDirProvider();

  const result = await provider.runCommand({ argv: ['pwd'], cwd: ctx.directory });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${ctx.directory}\n`, stderr: '' });
  expect(provider.calls).toStrictEqual([{ op: 'run', argv: ['pwd'], cwd: ctx.directory }]);
});

test('it runs the after-transfer step on the unpacked directory before the transfer resolves', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'src'));
  writeFileSync(join(ctx.directory, 'src', 'hello.txt'), 'hello\n');

  const archive = await $`tar -c -f - -C ${join(ctx.directory, 'src')} .`.arrayBuffer();

  const provider = createStubDirProvider({
    afterTransfer: async (directory) => {
      await Bun.write(join(directory, 'hello.txt'), 'changed\n');
    },
  });

  await provider.transferArchive(new Uint8Array(archive), join(ctx.directory, 'ws'));

  expect(readFileSync(join(ctx.directory, 'ws', 'hello.txt'), 'utf8')).toBe('changed\n');
});

test('it declares the capabilities it is told it lacks as missing', () => {
  const provider = createStubDirProvider({ lacking: ['transfer', 'run'] });

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
  const ctx = setupTest();

  const transfer = createStubDirProvider().transferArchive(
    new Uint8Array([1, 2, 3]),
    join(ctx.directory, 'ws'),
  );

  expect(transfer).rejects.toThrowWithMessage(
    Error,
    new RegExp(`^tar exited [1-9]\\d* unpacking into ${join(ctx.directory, 'ws')}: \\S`, 'u'),
  );
});

test('it refuses to suspend a host', () => {
  const provider = createStubDirProvider();

  expect(provider.suspendHost('h1')).rejects.toThrowWithMessage(
    Error,
    'the fixture-dir provider cannot suspend host h1',
  );
});

test('it refuses to destroy a host', () => {
  const provider = createStubDirProvider();

  expect(provider.destroyHost('h1')).rejects.toThrowWithMessage(
    Error,
    'the fixture-dir provider cannot destroy host h1',
  );
});

test('it starts a harness on a local terminal and records its spec', async () => {
  const ctx = setupTest();
  const provider = createStubDirProvider();

  const spec = {
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: ctx.directory,
    env: { DEBUG: '1' },
    cols: 80,
    rows: 24,
  };

  const exited = Promise.withResolvers<number>();
  const harness = provider.spawnHarness(spec);

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  const exitCode = await exited.promise;

  expect(provider.harnesses).toStrictEqual([spec]);
  expect(exitCode).toBe(0);
});
