import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runATC } from '@atc/app/test-utils/run-atc';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { startStubReporterSocket } from '@atc/protocol/test-utils/start-stub-reporter-socket';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-answer-');
  const sock = join(temporaryDirectory.path, 'reporter.sock');
  const reporter = startStubReporterSocket(sock);

  return { home: temporaryDirectory.path, sock, reporter };
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
