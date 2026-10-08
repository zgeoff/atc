import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

// A temp directory that stands in for a checkout, with a project nested
// inside it the way AGENTS.md places a worktree.
function setupTest() {
  const tmp = setupTempDir('atc-deadcode-');

  return { dir: tmp.dir };
}

test('it checks a project nested under a checkout whose tsconfig extends a package the checkout cannot resolve', () => {
  const ctx = setupTest();
  const project = join(ctx.dir, '.worktrees', 'me', 'branch');

  writeFileSync(
    join(ctx.dir, 'tsconfig.json'),
    JSON.stringify({ extends: '@example/absent/tsconfig.json' }),
  );

  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'nested', type: 'module' }));
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({}));
  writeFileSync(join(project, 'knip.json'), JSON.stringify({ entry: ['index.js'] }));
  writeFileSync(join(project, 'index.js'), 'export {};\n');

  const run = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '..', 'node_modules', '.bin', 'knip')],
    {
      cwd: project,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect({
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
});
