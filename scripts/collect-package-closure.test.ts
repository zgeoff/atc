import { expect, test } from 'bun:test';
import { collectPackageClosure } from './collect-package-closure';

test('it follows manifest dependencies through every level and leaves out unrelated packages', () => {
  const workspace = [
    { name: 'core', dir: 'packages/core', deps: [] },
    { name: 'protocol', dir: 'packages/protocol', deps: ['core'] },
    { name: 'plugin-api', dir: 'packages/plugin-api', deps: ['core', 'protocol'] },
    { name: 'store', dir: 'packages/store', deps: ['core'] },
    { name: 'test-utils', dir: 'packages/test-utils', deps: ['core'] },
    { name: 'harness-claude', dir: 'packages/harnesses/claude', deps: ['plugin-api'] },
  ];

  expect(collectPackageClosure(workspace, ['harness-claude', 'test-utils'])).toIncludeSameMembers([
    { name: 'harness-claude', dir: 'packages/harnesses/claude', deps: ['plugin-api'] },
    { name: 'plugin-api', dir: 'packages/plugin-api', deps: ['core', 'protocol'] },
    { name: 'protocol', dir: 'packages/protocol', deps: ['core'] },
    { name: 'core', dir: 'packages/core', deps: [] },
    { name: 'test-utils', dir: 'packages/test-utils', deps: ['core'] },
  ]);
});

test('it lists a package two others depend on once', () => {
  const workspace = [
    { name: 'core', dir: 'packages/core', deps: [] },
    { name: 'config', dir: 'packages/config', deps: ['core'] },
    { name: 'source-git', dir: 'packages/sources/git', deps: ['core', 'config'] },
  ];

  expect(collectPackageClosure(workspace, ['source-git'])).toHaveLength(3);
});

test('it skips a dependency name that matches no workspace package', () => {
  const workspace = [{ name: 'harness-grok', dir: 'packages/harnesses/grok', deps: ['missing'] }];

  expect(collectPackageClosure(workspace, ['harness-grok'])).toStrictEqual([
    { name: 'harness-grok', dir: 'packages/harnesses/grok', deps: ['missing'] },
  ]);
});
