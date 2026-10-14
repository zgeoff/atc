import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { buildStubMenuClaude } from './build-stub-menu-claude';

test('it runs the stand-in script under Bun with the spec and log paths', () => {
  expect(buildStubMenuClaude('/tmp/menu.json', '/tmp/menu.log')).toStrictEqual({
    bin: process.execPath,
    args: [expect.toEndWith('/run-stub-menu-claude.ts'), '/tmp/menu.json', '/tmp/menu.log'],
  });
});

test('it points at a script that exists', () => {
  const plan = buildStubMenuClaude('/tmp/menu.json', '/tmp/menu.log');

  expect(existsSync(plan.args[0] ?? '')).toBeTrue();
});
