import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStubReporterSocket } from '@atc/protocol/test-utils/start-stub-reporter-socket';
import { startStubSessionBridge } from '@atc/protocol/test-utils/start-stub-session-bridge';
import { updateEnv } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { runStatusline } from './run-statusline';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-statusline-');

  updateEnv('CLAUDE_CONFIG_DIR', temporaryDirectory.path);

  return {
    directory: temporaryDirectory.path,
    sock: join(temporaryDirectory.path, 'reporter.sock'),
  };
}

test('it prints only the output of the user statusline', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'ccline --short' } }),
  );

  const runChained = mock(() => Promise.resolve('CHAINED-SEGMENT\n'));
  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{"session_id":"sl-1"}'),
    runChained,
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(runChained).toHaveBeenCalledExactlyOnceWith('ccline --short', '{"session_id":"sl-1"}');
  expect(printed).toStrictEqual(['CHAINED-SEGMENT']);
});

test.each([
  { command: "atc statusline --agent='claude'" },
  { command: "atc statusline --agent 'claude'" },
  { command: 'atc statusline' },
  { command: 'bun /src/statusline.ts' },
])('it never chains $command, which is its own injected command', async (row) => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: row.command } }),
  );

  const runChained = mock(() => Promise.resolve('SHOULD-NOT-RUN'));

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    runChained,
    print: () => {},
    exit: () => {},
  });

  expect(runChained).not.toHaveBeenCalled();
});

test('it prints nothing when the user has no statusline', async () => {
  setupTest();

  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    runChained: () => Promise.resolve(''),
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(printed).toStrictEqual([]);
});

test("it reports the payload to the session's socket as a Statusline event", async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.sock);

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  await runStatusline('claude', {
    readStdin: () => Promise.resolve('{"session_id":"sl-1"}'),
    runChained: () => Promise.resolve(''),
    print: () => {},
    exit: () => {},
  });

  const line = await reporter.waitForLine();

  const report: unknown = JSON.parse(line);

  expect(report).toStrictEqual({
    atcId: 's1',
    agent: 'claude',
    event: 'Statusline',
    payload: { session_id: 'sl-1' },
  });
});

test('it adds no text of its own inside a remote host', async () => {
  const ctx = setupTest();

  startStubSessionBridge(ctx.sock, (request) =>
    request['op'] === 'status.read' ? [{ id: request['id'], ok: true, state: 'needs_you' }] : null,
  );

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', ctx.sock);

  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    runChained: () => Promise.resolve(''),
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(printed).toStrictEqual([]);
});

test('it exits 0 when the chained statusline fails', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'ccline' } }),
  );

  const codes: number[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    runChained: () => Promise.reject(new Error('bash: ccline: command not found')),
    print: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  expect(codes).toStrictEqual([0]);
});
