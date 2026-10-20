import { expect, test } from 'bun:test';
import { collectPackageClosure } from './collect-package-closure';

test('it follows manifest dependencies through every level and leaves out unrelated packages', () => {
  const workspace = [
    { name: 'core', directory: 'packages/core', deps: [] },
    { name: 'protocol', directory: 'packages/protocol', deps: ['core'] },
    { name: 'plugin-api', directory: 'packages/plugin-api', deps: ['core', 'protocol'] },
    { name: 'store', directory: 'packages/store', deps: ['core'] },
    { name: 'test-utils', directory: 'packages/test-utils', deps: ['core'] },
    { name: 'harness-claude', directory: 'packages/harnesses/claude', deps: ['plugin-api'] },
  ];

  expect(collectPackageClosure(workspace, ['harness-claude', 'test-utils'])).toIncludeSameMembers([
    { name: 'harness-claude', directory: 'packages/harnesses/claude', deps: ['plugin-api'] },
    { name: 'plugin-api', directory: 'packages/plugin-api', deps: ['core', 'protocol'] },
    { name: 'protocol', directory: 'packages/protocol', deps: ['core'] },
    { name: 'core', directory: 'packages/core', deps: [] },
    { name: 'test-utils', directory: 'packages/test-utils', deps: ['core'] },
  ]);
});

test('it lists a package two others depend on once', () => {
  const workspace = [
    { name: 'core', directory: 'packages/core', deps: [] },
    { name: 'config', directory: 'packages/config', deps: ['core'] },
    { name: 'source-git', directory: 'packages/sources/git', deps: ['core', 'config'] },
  ];

  expect(collectPackageClosure(workspace, ['source-git'])).toHaveLength(3);
});

test('it skips a dependency name that matches no workspace package', () => {
  const workspace = [
    { name: 'harness-grok', directory: 'packages/harnesses/grok', deps: ['missing'] },
  ];

  expect(collectPackageClosure(workspace, ['harness-grok'])).toStrictEqual([
    { name: 'harness-grok', directory: 'packages/harnesses/grok', deps: ['missing'] },
  ]);
});
