import { expect, test } from 'bun:test';
import { runCLICommand } from './run-cli-command.ts';

function setupTest() {
  const executed: (readonly string[])[] = [];

  return {
    executed,
    endpoints: {
      root: '/tmp/atc-test-home-pear',
      home: '/tmp/atc-test-home-pear/home',
      stub: '/stub',
      config: '/config',
      socket: '/socket',
      events: '/events',
      db: '/db',
      daemonLog: '/log',
      remote: 'http://127.0.0.1:1',
      gateway: 'http://127.0.0.1:2',
      gatewayWrong: 'http://127.0.0.1:3',
    },
    exec: (argv: readonly string[]) => {
      executed.push(argv);

      return Promise.resolve({ exitCode: 8, stdout: 'm-1\n', stderr: 'waited\n' });
    },
  };
}

test('it returns the exit code and output of the CLI, whatever the exit code', async () => {
  const ctx = setupTest();

  const result = await runCLICommand(ctx.exec, ctx.endpoints, '/repo/cli.ts', [
    'send',
    'wv-a',
    'hi',
  ]);

  expect(result).toStrictEqual({ exitCode: 8, stdout: 'm-1\n', stderr: 'waited\n' });
});

test('it runs the CLI entry with the arguments in the run home', async () => {
  const ctx = setupTest();

  await runCLICommand(ctx.exec, ctx.endpoints, '/repo/cli.ts', ['send', 'wv-a', 'hi']);

  expect(ctx.executed[0]).toStrictEqual(
    expect.arrayContaining([
      'HOME=/tmp/atc-test-home-pear/home',
      process.execPath,
      '/repo/cli.ts',
      'send',
      'wv-a',
      'hi',
    ]),
  );
});
