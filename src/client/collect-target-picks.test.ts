import { expect, test } from 'bun:test';
import { collectTargetPicks } from './collect-target-picks';

test('it reads each target with whether it takes a workspace and runs in place', () => {
  const picks = collectTargetPicks({
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        identity: 'local-pty:44136fa355b3678a',
        available: true,
        default: true,
        capabilities: { spawn: true, transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        identity: 'imp:0d1f',
        available: true,
        default: false,
        capabilities: { spawn: true, transfer: false, run: true },
      },
      {
        id: 'gone',
        provider: 'other',
        identity: 'other:1',
        available: false,
        default: false,
        capabilities: { spawn: true, transfer: true, run: true },
      },
    ],
  });

  expect(picks).toStrictEqual([
    {
      id: 'local',
      provider: 'local-pty',
      available: true,
      isDefault: true,
      takesWorkspace: true,
      inPlace: true,
    },
    {
      id: 'box',
      provider: 'imp',
      available: true,
      isDefault: false,
      takesWorkspace: false,
      inPlace: false,
    },
    {
      id: 'gone',
      provider: 'other',
      available: false,
      isDefault: false,
      takesWorkspace: false,
      inPlace: false,
    },
  ]);
});

test.each([
  [{}],
  [{ targets: 'local' }],
  [{ targets: [7, { id: 'x' }, { provider: 'local-pty' }] }],
])('it reads no targets from %p', (answer) => {
  expect(collectTargetPicks(answer)).toStrictEqual([]);
});
