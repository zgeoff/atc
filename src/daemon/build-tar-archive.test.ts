import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { buildTarArchive } from './build-tar-archive';

test('it packs files that tar unpacks with their content, parent directories, and modes', async () => {
  using tmp = setupTempDir('atc-tar-');

  const archive = buildTarArchive([
    { path: 'settings.json', content: '{"hooks":{}}' },
    { path: 'bin/atc', content: new Uint8Array([0, 1, 2, 255]), mode: 0o755 },
    { path: 'bridge/hooks/register.ts', content: 'x'.repeat(1000) },
  ]);

  const proc = Bun.spawn(['tar', '-x', '-f', '-', '-C', tmp.dir], {
    stdin: archive,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderr = await new Response(proc.stderr).text();

  expect({ code: await proc.exited, stderr }).toStrictEqual({ code: 0, stderr: '' });
  expect(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
  expect([...readFileSync(join(tmp.dir, 'bin', 'atc'))]).toStrictEqual([0, 1, 2, 255]);
  expect(statSync(join(tmp.dir, 'bin', 'atc')).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(tmp.dir, 'bridge', 'hooks', 'register.ts'), 'utf8')).toHaveLength(1000);
});

test('it refuses a path longer than an archive header holds', () => {
  expect(() => buildTarArchive([{ path: 'a'.repeat(101), content: '' }])).toThrow(
    'longer than 100 bytes',
  );
});
