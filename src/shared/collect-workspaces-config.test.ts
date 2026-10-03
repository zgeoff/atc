import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the configured GitHub owner', () => {
  expect(collectWorkspacesConfig({ githubOwner: 'zgeoff' })).toStrictEqual({
    githubOwner: 'zgeoff',
  });
});

test.each([
  [undefined],
  [null],
  ['zgeoff'],
  [{}],
  [{ githubOwner: 7 }],
  [{ githubOwner: '--x' }],
  [{ githubOwner: 'a/b' }],
])('it reads no GitHub owner from %p', (raw) => {
  expect(collectWorkspacesConfig(raw)).toStrictEqual({ githubOwner: null });
});
