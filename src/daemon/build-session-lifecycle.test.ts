import { expect, test } from 'bun:test';
import { buildSessionLifecycle } from './build-session-lifecycle';

test('it reports a harness that holds a terminal as running', () => {
  expect(
    buildSessionLifecycle({
      desired: 'run',
      vm: 'none',
      attachment: 'local',
      hasHarness: true,
      kind: 'pty',
      state: 'needs_you',
    }),
  ).toStrictEqual({ desired: 'run', vm: 'none', harness: 'running', attachment: 'local' });
});

test('it reports a live headless run as a running harness', () => {
  expect(
    buildSessionLifecycle({
      desired: 'run',
      vm: 'none',
      attachment: 'local',
      hasHarness: false,
      kind: 'headless',
      state: 'running',
    }),
  ).toStrictEqual({ desired: 'run', vm: 'none', harness: 'running', attachment: 'local' });
});

test('it reports a harness kept inside a sleeping host as suspended', () => {
  expect(
    buildSessionLifecycle({
      desired: 'sleep',
      vm: 'asleep',
      attachment: 'detached',
      hasHarness: false,
      kind: 'pty',
      state: 'exited',
    }),
  ).toStrictEqual({ desired: 'sleep', vm: 'asleep', harness: 'suspended', attachment: 'detached' });
});

test('it reports a harness whose host never went to sleep as exited', () => {
  expect(
    buildSessionLifecycle({
      desired: 'sleep',
      vm: 'awake',
      attachment: 'detached',
      hasHarness: false,
      kind: 'pty',
      state: 'exited',
    }),
  ).toStrictEqual({ desired: 'sleep', vm: 'awake', harness: 'exited', attachment: 'detached' });
});

test('it reports a harness that ended on the daemon machine as exited', () => {
  expect(
    buildSessionLifecycle({
      desired: 'run',
      vm: 'none',
      attachment: 'local',
      hasHarness: false,
      kind: 'pty',
      state: 'exited',
    }),
  ).toStrictEqual({ desired: 'run', vm: 'none', harness: 'exited', attachment: 'local' });
});
