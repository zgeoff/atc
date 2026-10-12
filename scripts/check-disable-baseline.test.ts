import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '../packages/app/src/test-utils/run-command';
import { setupTempDir } from '../packages/app/src/test-utils/setup-temp-dir';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-disable-baseline-');

  return { dir: tmp.dir };
}

test('it passes a count at the baseline, skipping other rules and strings', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/disable-baseline.json'),
    JSON.stringify({ importRuleDisables: 1 }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/src/a.ts'),
    [
      '// oxlint-disable-next-line no-restricted-imports -- the opener the gateway injects',
      "import { Database } from 'bun:sqlite';",
      '',
      '// oxlint-disable-next-line no-console',
      'console.log(Database);',
      '',
      "export const TEXT = '// oxlint-disable-next-line no-restricted-imports';",
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-disable-baseline.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-disable-baseline: 1 directives, baseline 1\n',
    stderr: 'import rule disabled: packages/store/src/a.ts:1\n',
  });
});

test('it fails on more import rule directives than the baseline', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/disable-baseline.json'),
    JSON.stringify({ importRuleDisables: 1 }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    [
      "import { Database } from 'bun:sqlite'; // eslint-disable-line eslint/no-restricted-imports",
      '',
      '/* oxlint-disable */',
      "export const PTY = await import('bun-pty');",
      '',
      'export const DB = Database;',
      '',
    ].join('\n'),
  );

  await Bun.write(
    join(ctx.dir, 'e2e/journey.test.ts'),
    "// oxlint-disable-next-line import/no-cycle\nimport { A } from './a';\n\nexport const B = A;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-disable-baseline.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-disable-baseline: 3 directives, baseline 1\n',
    stderr:
      'import rule disabled: packages/tui/src/a.ts:1\nimport rule disabled: packages/tui/src/a.ts:3\nimport rule disabled: e2e/journey.test.ts:1\ncheck-disable-baseline: 2 more than the baseline in scripts/disable-baseline.json\n',
  });
});

test('it counts a block directive whose rules span several lines', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/disable-baseline.json'),
    JSON.stringify({ importRuleDisables: 0 }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    [
      'export const A = 1;',
      '',
      '/* eslint-disable import/newline-after-import,',
      '   no-restricted-imports */',
      "import { Database } from 'bun:sqlite';",
      '',
      'export const DB = Database;',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-disable-baseline.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-disable-baseline: 1 directives, baseline 0\n',
    stderr:
      'import rule disabled: packages/tui/src/a.ts:3\ncheck-disable-baseline: 1 more than the baseline in scripts/disable-baseline.json\n',
  });
});

test('it skips directive text inside a multiline template', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/disable-baseline.json'),
    JSON.stringify({ importRuleDisables: 0 }),
  );

  await Bun.write(
    join(ctx.dir, 'scripts/a.test.ts'),
    [
      'export const FIXTURE = `',
      '// oxlint-disable-next-line no-restricted-imports',
      "import { Database } from 'bun:sqlite';",
      '  /* eslint-disable */',
      `\${String(1)}`,
      '// oxlint-disable',
      '`;',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-disable-baseline.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-disable-baseline: 0 directives, baseline 0\n',
    stderr: '',
  });
});

test('it asks for a lower baseline when the count falls below it', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/disable-baseline.json'),
    JSON.stringify({ importRuleDisables: 2 }),
  );

  await Bun.write(join(ctx.dir, 'packages/core/src/a.ts'), 'export const A = 1;\n');

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-disable-baseline.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout:
      'check-disable-baseline: 0 directives, baseline 2\ncheck-disable-baseline: lower the baseline in scripts/disable-baseline.json to 0\n',
    stderr: '',
  });
});
