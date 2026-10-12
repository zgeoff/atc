import { expect, test } from 'bun:test';
import { buildMockRegistryDaemon } from './build-mock-registry-daemon';

test('it builds a default registry daemon', () => {
  const daemon = buildMockRegistryDaemon();

  expect(daemon).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    address: {
      host: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+\.\d+$/u.test(value)),
      port: expect.toBeNumber(),
    },
    daemonID: expect.toSatisfy((value: string) => /^[0-9a-f-]{36}$/u.test(value)),
    incarnation: expect.toSatisfy(
      (value: string) => value.length === 8 && daemon.daemonID.startsWith(value),
    ),
    token: expect.toSatisfy((value: string) => /^[0-9a-f]{32}$/u.test(value)),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockRegistryDaemon({
      name: 'cloud',
      address: { port: 8415 },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
    }),
  ).toStrictEqual({
    name: 'cloud',
    address: { host: expect.toBeString(), port: 8415 },
    daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
    incarnation: '0f6c2a8e',
    token: expect.toBeString(),
  });
});
