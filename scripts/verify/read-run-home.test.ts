import { expect, test } from 'bun:test';
import { readRunHome } from './read-run-home.ts';

test('it reads the run folders from the test home variables', () => {
  const env = {
    ATC_TEST_HOME: '/tmp/atc-test-home-pear',
    ATC_CLI_ENTRY: '/repo/cli.ts',
    ATC_GATEWAY_ENTRY: '/repo/gateway.ts',
  };

  expect(readRunHome(env)).toStrictEqual({
    root: '/tmp/atc-test-home-pear',
    home: '/tmp/atc-test-home-pear/home',
    runtime: '/tmp/atc-test-home-pear/runtime',
    cli: '/repo/cli.ts',
    gateway: '/repo/gateway.ts',
  });
});

test('it refuses a process that with-test-home.sh did not start', () => {
  expect(() =>
    readRunHome({ ATC_CLI_ENTRY: '/repo/cli.ts', ATC_GATEWAY_ENTRY: '/repo/gateway.ts' }),
  ).toThrow(/with-test-home\.sh/u);
});
