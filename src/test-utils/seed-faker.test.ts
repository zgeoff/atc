import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from './run-command';

test('it makes faker values repeat from one run to the next', async () => {
  const run = [
    process.execPath,
    '--preload',
    join(import.meta.dir, 'seed-faker.ts'),
    '-e',
    "import { faker } from '@faker-js/faker'; console.log(faker.string.uuid(), faker.date.recent().toISOString());",
  ];

  const first = await runCommand(run, { cwd: import.meta.dir });
  const second = await runCommand(run, { cwd: import.meta.dir });

  expect(second.stdout).toBe(first.stdout);
  expect(first.stdout).toMatch(/^[0-9a-f-]{36} 2025-12-3\d.*Z\n$/u);
});
