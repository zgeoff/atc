import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runHookReport } from './hook-report';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubReporterSocket } from './test-utils/start-stub-reporter-socket';
import { updateEnv } from './test-utils/update-env';

/**
 * A stub of the daemon's reporter socket in a temp directory, for the
 * reporter to send its line to. The stub stops, and the directory goes,
 * once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-hook-report-');
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = startStubReporterSocket(sock);

  return { sock, reporter };
}

test('it forwards a Claude SessionStart envelope as SessionStart', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runHookReport('', {
    readStdin: () =>
      Promise.resolve(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'claude-1' })),
    exit: (code) => {
      codes.push(code);
    },
  });

  const line = await ctx.reporter.waitForLine();

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'SessionStart',
    payload: { hook_event_name: 'SessionStart', session_id: 'claude-1' },
  });
});

test('it forwards a Grok session_start envelope as SessionStart', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runHookReport('', {
    readStdin: () =>
      Promise.resolve(JSON.stringify({ hookEventName: 'session_start', sessionId: 'grok-1' })),
    exit: (code) => {
      codes.push(code);
    },
  });

  const line = await ctx.reporter.waitForLine();

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'grok-1' },
  });
});

test('it exits 0 and forwards no event name when both event name keys are missing', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runHookReport('', {
    readStdin: () => Promise.resolve(JSON.stringify({ sessionId: 'grok-1' })),
    exit: (code) => {
      codes.push(code);
    },
  });

  const line = await ctx.reporter.waitForLine();

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    payload: { sessionId: 'grok-1' },
  });
});

test('it forwards the agent it is given', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  await runHookReport('codex', {
    readStdin: () =>
      Promise.resolve(JSON.stringify({ hook_event_name: 'Stop', session_id: 'codex-1' })),
    exit: (code) => {
      codes.push(code);
    },
  });

  const line = await ctx.reporter.waitForLine();

  expect(codes).toStrictEqual([0]);

  expect(JSON.parse(line) as unknown).toStrictEqual({
    atcId: 's1',
    agent: 'codex',
    event: 'Stop',
    payload: { hook_event_name: 'Stop', session_id: 'codex-1' },
  });
});
