import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

test('it imports the imp client library only from imp modules', async () => {
  const importers: string[] = [];

  for (const dir of ['src', 'e2e', 'scripts', 'mods']) {
    for await (const path of new Bun.Glob('**/*.{ts,tsx,js,mjs}').scan(join(ROOT, dir))) {
      const source = readFileSync(join(ROOT, dir, path), 'utf8');

      if (/(?:from|import\()\s*['"]@zgeoff\/imp-client['"]/u.test(source)) {
        importers.push(join(dir, path));
      }
    }
  }

  expect(importers.filter((path) => !basename(path).startsWith('imp'))).toBeEmpty();
  expect(importers).toStrictEqual(['src/daemon/imp-client-port.ts']);
});
