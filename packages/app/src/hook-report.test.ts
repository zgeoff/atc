import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir, startStubReporterSocket, updateEnv } from '@atc/test-utils';
import { runHookReport } from './hook-report';

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

test('it forwards nothing for a hook of a Codex run that a Codex tool started', async () => {
  const ctx = setupTest();

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  const codes: number[] = [];

  updateEnv('CODEX_THREAD_ID', 'codex-parent');

  await runHookReport('codex', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'codex-nested' }),
      ),
    exit: (code) => {
      codes.push(code);
    },
  });

  updateEnv('CODEX_THREAD_ID', undefined);

  await runHookReport('codex', {
    readStdin: () =>
      Promise.resolve(JSON.stringify({ hook_event_name: 'Stop', session_id: 'codex-parent' })),
    exit: (code) => {
      codes.push(code);
    },
  });

  await ctx.reporter.waitForLine();

  expect(codes).toStrictEqual([0, 0]);

  expect(ctx.reporter.lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    {
      atcId: 's1',
      agent: 'codex',
      event: 'Stop',
      payload: { hook_event_name: 'Stop', session_id: 'codex-parent' },
    },
  ]);
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
