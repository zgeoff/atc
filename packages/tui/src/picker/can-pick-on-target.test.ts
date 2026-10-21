import { expect, test } from 'bun:test';
import { DEFAULT_GIT_TRANSPORTS } from '@atc/config';
import { canPickOnTarget } from './can-pick-on-target';

test.each([
  ['no root at all', null, []],
  ['a home-relative root', '~/ws', []],
  ['the home itself as the root', '~', []],
  ['a home-relative root for the target over an absolute one', '/srv/ws', [['box', '~/box-ws']]],
] as const)('it lets the daemon pick the destination with %s', (_label, root, targetRoots) => {
  const workspaces = {
    githubOwner: null,
    sources: null,
    gitTransports: DEFAULT_GIT_TRANSPORTS,
    root,
    targetRoots: new Map(targetRoots),
  };

  expect(canPickOnTarget(workspaces, 'box')).toBe(true);
});

test.each([
  ['an absolute root', '/srv/ws', []],
  ['an absolute root for the target', null, [['box', '/srv/box-ws']]],
  ['an absolute root for the target over a home-relative one', '~/ws', [['box', '/srv/box-ws']]],
  ['a root that only starts with a tilde', '~ws', []],
  ['a relative root', 'ws', []],
] as const)(
  'it refuses to let the daemon pick the destination with %s',
  (_label, root, targetRoots) => {
    const workspaces = {
      githubOwner: null,
      sources: null,
      gitTransports: DEFAULT_GIT_TRANSPORTS,
      root,
      targetRoots: new Map(targetRoots),
    };

    expect(canPickOnTarget(workspaces, 'box')).toBe(false);
  },
);
