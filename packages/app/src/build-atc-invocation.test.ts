import { expect, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils/build-mock-host-services';
import { buildATCInvocation } from './build-atc-invocation';

test("it starts the CLI with the host's argv", () => {
  const host = buildMockHostServices({
    atcArgv: ['/usr/bin/bun', '/repo/packages/app/src/cli.ts'],
  });

  expect(buildATCInvocation(host).argv).toStrictEqual([
    '/usr/bin/bun',
    '/repo/packages/app/src/cli.ts',
  ]);
});

test("it reads the host's build again on every call", () => {
  const host = buildMockHostServices();
  const builds = ['4.2.0+src.1', '4.2.0+src.2'];

  // A host whose build moves on, the way a rebuild of the checkout moves it.
  Object.defineProperty(host, 'build', { get: () => builds.shift() });

  const invocation = buildATCInvocation(host);

  expect([invocation.readBuild(), invocation.readBuild()]).toStrictEqual([
    '4.2.0+src.1',
    '4.2.0+src.2',
  ]);
});
