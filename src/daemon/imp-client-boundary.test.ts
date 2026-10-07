import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('it imports the imp client library only from imp modules', async () => {
  const root = join(import.meta.dir, '..', '..');

  const paths = await Array.fromAsync(
    new Bun.Glob('{src,e2e,scripts,mods}/**/*.{ts,tsx,js,mjs}').scan(root),
  );

  const importers = paths.filter((path) =>
    /(?:from|import\()\s*['"]@zgeoff\/imp-client['"]/u.test(readFileSync(join(root, path), 'utf8')),
  );

  expect(importers).toStrictEqual(['src/daemon/imp-client-port.ts']);
});
