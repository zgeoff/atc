import { expect, test } from 'bun:test';
import { collectHomeNotices } from './collect-home-notices';

test.each([
  [{ daemonName: null, notice: null, isWaiting: false, isRestarting: false, isStale: false }, []],
  [
    {
      daemonName: null,
      notice: 'kept folder /tmp/work',
      isWaiting: false,
      isRestarting: false,
      isStale: false,
    },
    ['kept folder /tmp/work'],
  ],
  [
    { daemonName: null, notice: null, isWaiting: false, isRestarting: false, isStale: true },
    ['⟳ update ready'],
  ],
  [
    { daemonName: null, notice: null, isWaiting: false, isRestarting: true, isStale: true },
    ['⟳ restarting daemon'],
  ],
  [
    { daemonName: null, notice: null, isWaiting: true, isRestarting: true, isStale: false },
    ['⟳ waiting for daemon'],
  ],
  [
    { daemonName: null, notice: 'refused', isWaiting: false, isRestarting: false, isStale: true },
    ['refused', '⟳ update ready'],
  ],
  [
    { daemonName: 'box', notice: 'refused', isWaiting: false, isRestarting: false, isStale: false },
    ['@box', 'refused'],
  ],
])('#collectHomeNotices lists the notices for %o', (source, expected) => {
  expect(collectHomeNotices(source)).toStrictEqual(expected);
});
