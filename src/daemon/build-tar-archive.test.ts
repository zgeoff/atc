import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildTarArchive } from './build-tar-archive';

function setupTest() {
  const tmp = setupTempDir('atc-tar-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it packs files that tar unpacks with their content, parent directories, and modes', async () => {
  using ctx = setupTest();

  const archive = buildTarArchive([
    { path: 'settings.json', content: '{"hooks":{}}' },
    { path: 'bin/atc', content: new Uint8Array([0, 1, 2, 255]), mode: 0o755 },
    { path: 'bridge/hooks/register.ts', content: 'x'.repeat(1000) },
  ]);

  const proc = Bun.spawn(['tar', '-x', '-f', '-', '-C', ctx.dir], {
    stdin: archive,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  expect({ code: await proc.exited, stderr }).toStrictEqual({ code: 0, stderr: '' });
  expect(readFileSync(join(ctx.dir, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
  expect([...readFileSync(join(ctx.dir, 'bin', 'atc'))]).toStrictEqual([0, 1, 2, 255]);
  expect(statSync(join(ctx.dir, 'bin', 'atc')).mode & 0o777).toBe(0o755);
  expect(statSync(join(ctx.dir, 'bridge', 'hooks')).isDirectory()).toBeTrue();

  expect(readFileSync(join(ctx.dir, 'bridge', 'hooks', 'register.ts'), 'utf8')).toBe(
    'x'.repeat(1000),
  );
});

test('it packs a path longer than 100 bytes that tar unpacks at the full path', async () => {
  using ctx = setupTest();

  const path = `${'d'.repeat(80)}/${'e'.repeat(60)}/${'f'.repeat(90)}.md`;

  const proc = Bun.spawn(['tar', '-x', '-f', '-', '-C', ctx.dir], {
    stdin: buildTarArchive([{ path, content: 'deep' }]),
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  expect({ code: await proc.exited, stderr }).toStrictEqual({ code: 0, stderr: '' });
  expect(readFileSync(join(ctx.dir, path), 'utf8')).toBe('deep');
});

test('it refuses a path that fits no split into an archive header', () => {
  expect(() => buildTarArchive([{ path: 'a'.repeat(101), content: '' }])).toThrow(
    'does not fit a ustar header',
  );
});
