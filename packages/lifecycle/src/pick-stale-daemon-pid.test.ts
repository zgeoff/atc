import { expect, test } from 'bun:test';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';
import { buildMockDaemonRecord } from './testing/build-mock-daemon-record';

test('it picks the recorded pid when the record lists the refusing socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: buildMockDaemonRecord({ pid: 200, socketPath: '/run/user/1000/atc-daemon.sock' }),
      pidFileSocketPath: '/run/user/1000/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBe(200);
});

test('it picks the pid file beside the refusing socket when the record lists another socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: buildMockDaemonRecord({
        pid: 200,
        socketPath: '/home/me/.local/state/atc/atc-daemon.sock',
      }),
      pidFileSocketPath: '/run/user/1000/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBe(100);
});

test('it picks no pid when neither the record nor the pid file belongs to the refusing socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: buildMockDaemonRecord({
        pid: 200,
        socketPath: '/home/me/.local/state/atc/atc-daemon.sock',
      }),
      pidFileSocketPath: '/home/me/.local/state/atc/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBeNull();
});

test('it picks the pid file beside the refusing socket when there is no record', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: null,
      pidFileSocketPath: '/run/user/1000/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBe(100);
});
