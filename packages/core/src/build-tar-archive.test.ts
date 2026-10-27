import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildTarArchive } from './build-tar-archive';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-tar-');

  return { directory: temporaryDirectory.path };
}

test('it packs files that tar unpacks with their content, parent directories, and modes', async () => {
  const ctx = setupTest();

  const archive = buildTarArchive([
    { path: 'settings.json', content: '{"hooks":{}}' },
    { path: 'bin/atc', content: new Uint8Array([0, 1, 2, 255]), mode: 0o755 },
    { path: 'bridge/hooks/register.ts', content: 'x'.repeat(1000) },
  ]);

  // Without -p, tar run by a user other than root masks each mode with the umask.
  const subprocess = Bun.spawn(['tar', '-x', '-p', '-f', '-', '-C', ctx.directory], {
    stdin: archive,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  const stderr = await new Response(subprocess.stderr).text();

  expect({ code: await subprocess.exited, stderr }).toStrictEqual({ code: 0, stderr: '' });
  expect(readFileSync(join(ctx.directory, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
  expect([...readFileSync(join(ctx.directory, 'bin', 'atc'))]).toStrictEqual([0, 1, 2, 255]);
  expect(statSync(join(ctx.directory, 'bin', 'atc')).mode & 0o777).toBe(0o755);
  expect(statSync(join(ctx.directory, 'bridge', 'hooks')).isDirectory()).toBeTrue();

  expect(readFileSync(join(ctx.directory, 'bridge', 'hooks', 'register.ts'), 'utf8')).toBe(
    'x'.repeat(1000),
  );
});

test('it packs a path longer than 100 bytes that tar unpacks at the full path', async () => {
  const ctx = setupTest();
  const path = `${'d'.repeat(80)}/${'e'.repeat(60)}/${'f'.repeat(90)}.md`;

  const subprocess = Bun.spawn(['tar', '-x', '-f', '-', '-C', ctx.directory], {
    stdin: buildTarArchive([{ path, content: 'deep' }]),
    stdout: 'ignore',
    stderr: 'pipe',
  });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  const stderr = await new Response(subprocess.stderr).text();

  expect({ code: await subprocess.exited, stderr }).toStrictEqual({ code: 0, stderr: '' });
  expect(readFileSync(join(ctx.directory, path), 'utf8')).toBe('deep');
});

test('it refuses a path that fits no split into an archive header', () => {
  expect(() => buildTarArchive([{ path: 'a'.repeat(101), content: '' }])).toThrow(
    'does not fit a ustar header',
  );
});
