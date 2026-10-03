import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the configured GitHub owner and source order', () => {
  expect(
    collectWorkspacesConfig({ githubOwner: 'zgeoff', sources: ['git', 'dirs'] }),
  ).toStrictEqual({
    githubOwner: 'zgeoff',
    sources: ['git', 'dirs'],
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
  expect(collectWorkspacesConfig(raw)).toStrictEqual({ githubOwner: null, sources: null });
});

test.each([[{ sources: 'dirs' }], [{ sources: ['dirs', 7] }], [{ sources: ['dirs', ''] }]])(
  'it reads the default source order from %p',
  (raw) => {
    expect(collectWorkspacesConfig(raw).sources).toBeNull();
  },
);
