import { expect, test } from 'bun:test';
import { buildMockRemoteDaemon } from './build-mock-remote-daemon';

test('it builds a default remote daemon', () => {
  expect(buildMockRemoteDaemon()).toStrictEqual({
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
    host: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+\.\d+$/u.test(value)),
    port: expect.toBeNumber(),
    token: {
      kind: 'file',
      path: expect.toSatisfy((value: string) => /^\/[a-z]{8}\/daemon\.token$/u.test(value)),
    },
    principal: expect.toSatisfy((value: string) => /^[a-z]{8}$/u.test(value)),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockRemoteDaemon({ name: 'box', port: 7420, principal: 'laptop' })).toStrictEqual({
    name: 'box',
    host: expect.toBeString(),
    port: 7420,
    token: { kind: 'file', path: expect.toBeString() },
    principal: 'laptop',
  });
});

test('it replaces the default token file with a token command whole', () => {
  expect(
    buildMockRemoteDaemon({ token: { kind: 'command', argv: ['cat', '/etc/atc/box.token'] } })
      .token,
  ).toStrictEqual({ kind: 'command', argv: ['cat', '/etc/atc/box.token'] });
});
