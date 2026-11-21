import { expect, test } from 'bun:test';
import { collectHomeNotices } from './collect-home-notices';

test.each([
  [{ notice: null, isWaiting: false, isRestarting: false, isStale: false }, []],
  [
    { notice: 'kept folder /tmp/work', isWaiting: false, isRestarting: false, isStale: false },
    ['kept folder /tmp/work'],
  ],
  [{ notice: null, isWaiting: false, isRestarting: false, isStale: true }, ['⟳ update ready']],
  [{ notice: null, isWaiting: false, isRestarting: true, isStale: true }, ['⟳ restarting daemon']],
  [{ notice: null, isWaiting: true, isRestarting: true, isStale: false }, ['⟳ waiting for daemon']],
  [
    { notice: 'refused', isWaiting: false, isRestarting: false, isStale: true },
    ['refused', '⟳ update ready'],
  ],
])('#collectHomeNotices lists the notices for %o', (source, expected) => {
  expect(collectHomeNotices(source)).toStrictEqual(expected);
});
