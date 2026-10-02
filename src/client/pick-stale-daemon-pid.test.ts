import { expect, test } from 'bun:test';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';

test('it picks the recorded pid when the record lists the refusing socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: {
        pid: 200,
        socketPath: '/run/user/1000/atc-daemon.sock',
        reporterSocketPath: '/run/user/1000/atc.sock',
        eventsSocketPath: null,
      },
      pidFileSocketPath: '/run/user/1000/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBe(200);
});

test('it picks the pid file beside the refusing socket when the record lists another socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: {
        pid: 200,
        socketPath: '/home/geoff/.local/state/atc/atc-daemon.sock',
        reporterSocketPath: '/home/geoff/.local/state/atc/atc.sock',
        eventsSocketPath: null,
      },
      pidFileSocketPath: '/run/user/1000/atc-daemon.sock',
      pidFilePID: 100,
    }),
  ).toBe(100);
});

test('it picks no pid when neither the record nor the pid file belongs to the refusing socket', () => {
  expect(
    pickStaleDaemonPID({
      socketPath: '/run/user/1000/atc-daemon.sock',
      record: {
        pid: 200,
        socketPath: '/home/geoff/.local/state/atc/atc-daemon.sock',
        reporterSocketPath: '/home/geoff/.local/state/atc/atc.sock',
        eventsSocketPath: null,
      },
      pidFileSocketPath: '/home/geoff/.local/state/atc/atc-daemon.sock',
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
