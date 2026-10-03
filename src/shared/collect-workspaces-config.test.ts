import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the GitHub owner, the global root, and each target root', () => {
  expect(
    collectWorkspacesConfig({
      githubOwner: 'zgeoff',
      root: '~/ws',
      targets: { box: '/home/dev/ws', bad: 7, empty: '' },
    }),
  ).toStrictEqual({
    githubOwner: 'zgeoff',
    root: '~/ws',
    targetRoots: new Map([['box', '/home/dev/ws']]),
  });
});

test.each([
  [undefined],
  [null],
  ['zgeoff'],
  [{}],
  [{ githubOwner: 7, root: 7, targets: 'box' }],
  [{ githubOwner: '--x', root: '' }],
  [{ githubOwner: 'a/b' }],
])('it reads no owner and no roots from %p', (raw) => {
  expect(collectWorkspacesConfig(raw)).toStrictEqual({
    githubOwner: null,
    root: null,
    targetRoots: new Map(),
  });
});
