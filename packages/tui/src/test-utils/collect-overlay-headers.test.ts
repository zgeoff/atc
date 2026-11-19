import { expect, test } from 'bun:test';
import { drawOverlay } from '../ui';
import { buildMockMirrorSession } from './build-mock-mirror-session';
import { buildStubTerminal } from './build-stub-terminal';
import { collectOverlayHeaders } from './collect-overlay-headers';

test('it reads each group header the grouped session list draws, in order', () => {
  const terminal = buildStubTerminal();

  drawOverlay(
    {
      sessions: [
        buildMockMirrorSession({ id: 'north', pinned: true, repoRoot: '/work/atlas' }),
        buildMockMirrorSession({ id: 'south', pinned: false, repoRoot: '/work/harbor' }),
      ],
      agentLabels: { claude: 'Claude' },
      agentModels: {},
      showTarget: false,
      selected: 0,
      confirmKill: false,
      confirmDestroy: false,
      filter: null,
      notice: null,
      stale: false,
      grouped: true,
    },
    terminal.write,
  );

  expect(collectOverlayHeaders(terminal.getText())).toStrictEqual(['pinned', '/work/harbor']);
});

test('it reads no header from output without one', () => {
  expect(collectOverlayHeaders('plain text')).toStrictEqual([]);
});
