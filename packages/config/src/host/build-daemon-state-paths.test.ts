import { expect, test } from 'bun:test';
import { buildDaemonStatePaths } from './build-daemon-state-paths';

test('it places the record and the lock beside the state database', () => {
  const paths = buildDaemonStatePaths('/srv/atc/state/atc.db');

  expect(paths).toStrictEqual({
    recordFile: '/srv/atc/state/daemon.json',
    lockFile: '/srv/atc/state/daemon.lock',
  });
});
