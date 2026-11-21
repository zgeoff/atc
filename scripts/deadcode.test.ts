import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-deadcode-');

  return { directory: temporaryDirectory.path };
}

test('it checks a project nested under a checkout whose tsconfig extends a package the checkout cannot resolve', async () => {
  const ctx = setupTest();
  const project = join(ctx.directory, '.worktrees', 'me', 'branch');

  writeFileSync(
    join(ctx.directory, 'tsconfig.json'),
    JSON.stringify({ extends: '@example/absent/tsconfig.json' }),
  );

  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'nested', type: 'module' }));
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({}));
  writeFileSync(join(project, 'knip.json'), JSON.stringify({ entry: ['index.js'] }));
  writeFileSync(join(project, 'index.js'), 'export {};\n');

  const result = await run([process.execPath, join(import.meta.dir, 'deadcode.ts')], {
    cwd: project,
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toStrictEqual(
    {
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
  );
});
