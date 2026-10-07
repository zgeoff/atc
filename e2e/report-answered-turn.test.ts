import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startStubReporterSocket } from '../src/test-utils/start-stub-reporter-socket';

/**
 * A home with a stub of the daemon's reporter socket in it, for the report
 * subcommand to send its line to. Disposal stops the stub and removes the
 * home.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-report-'));
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = stack.use(startStubReporterSocket(sock));
  const owned = stack.move();

  return {
    home: tmp.dir,
    sock,
    reporter,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it forwards one answered report for every message a turn answered, with the turn, through atc report', async () => {
  using ctx = setupTest();

  const reported = await runATC({
    command: resolveATCCommand(),
    args: ['report', 'answered', '--messages', 'm-1,m-2', '--turn', 't-7'],
    home: ctx.home,
    env: { ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdin: 'both done',
  });

  const line = await ctx.reporter.waitForLine();

  expect({ code: reported.exitCode, line: JSON.parse(line) as unknown }).toStrictEqual({
    code: 0,
    line: {
      atcId: 's1',
      event: 'Report',
      payload: { kind: 'answered', messages: ['m-1', 'm-2'], answer: 'both done', turn: 't-7' },
    },
  });
});
