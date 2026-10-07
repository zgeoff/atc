import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('it makes faker values repeat from one run to the next', () => {
  const run = [
    process.execPath,
    '--preload',
    join(import.meta.dir, 'seed-faker.ts'),
    '-e',
    "import { faker } from '@faker-js/faker'; console.log(faker.string.uuid());",
  ];

  const first = Bun.spawnSync(run, { cwd: import.meta.dir });
  const second = Bun.spawnSync(run, { cwd: import.meta.dir });

  expect(second.stdout.toString()).toBe(first.stdout.toString());
  expect(first.stdout.toString()).toMatch(/^[0-9a-f-]{36}\n$/u);
});
