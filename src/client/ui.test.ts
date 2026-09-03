import { expect, test } from 'bun:test';
import { buildOverlayHint } from './ui';
import type { OverlaySessionView } from './ui';

const liveClaude: OverlaySessionView = {
  id: 'auth',
  parent: null,
  name: 'auth',
  cwd: '/x',
  state: 'running',
  unread: false,
  lastMsg: 'started',
  alive: true,
  kind: 'pty',
  resumable: true,
  canEject: true,
  agent: 'claude',
  pinned: false,
  repoRoot: '/x',
};

test('it includes headless on a row whose agent can run a headless turn', () => {
  expect(buildOverlayHint(liveClaude)).toInclude('H headless');
});

test('it omits headless on a row whose agent cannot run one', () => {
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok', canEject: false })).not.toInclude('H');
});

test('it still names yank on a live Grok row', () => {
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok', canEject: false })).toInclude('y yank');
});

test('it points the pin action of a sub-session at its parent', () => {
  const parent: OverlaySessionView = { ...liveClaude, id: 'wrangler', pinned: true };
  const child: OverlaySessionView = { ...liveClaude, id: 'worker', parent: 'wrangler' };

  expect(buildOverlayHint(child, [parent, child])).toInclude('p unpin parent');
});

test('it keeps the plain pin action on a top-level session', () => {
  expect(buildOverlayHint(liveClaude, [liveClaude])).toInclude('p pin ');
});
