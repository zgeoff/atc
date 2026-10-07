import { expect, test } from 'bun:test';
import { buildMockDaemonRecord } from './build-mock-daemon-record';

test('it builds a default daemon record', () => {
  expect(buildMockDaemonRecord()).toStrictEqual({
    pid: expect.toBeWithin(2, 4_194_305),
    socketPath: expect.toEndWith('/atc-daemon.sock'),
    reporterSocketPath: expect.toEndWith('/atc.sock'),
    eventsSocketPath: null,
    listenPort: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockDaemonRecord({
      pid: 200,
      socketPath: '/run/user/1000/atc-daemon.sock',
      listenPort: 7400,
    }),
  ).toStrictEqual({
    pid: 200,
    socketPath: '/run/user/1000/atc-daemon.sock',
    reporterSocketPath: expect.toEndWith('/atc.sock'),
    eventsSocketPath: null,
    listenPort: 7400,
  });
});
