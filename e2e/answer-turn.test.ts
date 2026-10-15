import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveATCCommand, runATC, setupTempDir, startStubReporterSocket } from '@atc/test-utils';

/**
 * A home with a stub of the daemon's reporter socket in it, for the answer
 * subcommand to send its line to.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-answer-');
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = startStubReporterSocket(sock);

  return { home: tmp.dir, sock, reporter };
}

test('it forwards one answer for every message a turn answered, with the turn, through atc answer', async () => {
  const ctx = setupTest();

  const reported = await runATC({
    command: resolveATCCommand(),
    args: ['answer', '--messages', 'm-1,m-2', '--turn', 't-7'],
    home: ctx.home,
    env: { ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdin: 'both done',
  });

  const line = await ctx.reporter.waitForLine();

  expect(reported.exitCode).toBe(0);

  expect(JSON.parse(line)).toStrictEqual({
    atcId: 's1',
    event: 'Note',
    payload: { kind: 'answered', messages: ['m-1', 'm-2'], answer: 'both done', turn: 't-7' },
  });
});
