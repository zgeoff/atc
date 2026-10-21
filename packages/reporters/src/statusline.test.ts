import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setupTempDir,
  startStubReporterSocket,
  startStubSessionBridge,
  updateEnv,
} from '@atc/test-utils';
import { runStatusline } from './statusline';

// A Claude config folder the test writes its settings into, and a reporter
// socket in the same directory.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-statusline-');

  updateEnv('CLAUDE_CONFIG_DIR', temporaryDirectory.path);

  return {
    directory: temporaryDirectory.path,
    sock: join(temporaryDirectory.path, 'reporter.sock'),
  };
}

test('it chains the user statusline and appends the fleet segment', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'ccline --short' } }),
  );

  const runChained = mock(() => Promise.resolve('CHAINED-SEGMENT\n'));
  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{"session_id":"sl-1"}'),
    readStatusFile: () =>
      JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
    runChained,
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(runChained).toHaveBeenCalledExactlyOnceWith('ccline --short', '{"session_id":"sl-1"}');

  expect(printed).toStrictEqual([
    'CHAINED-SEGMENT \u001B[90m▏\u001B[0m \u001B[1;31m● 2 need you: auth-bug\u001B[0m \u001B[36m◐ 1\u001B[0m',
  ]);
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
    readStatusFile: () => '{}',
    runChained,
    print: () => {},
    exit: () => {},
  });

  expect(runChained).not.toHaveBeenCalled();
});

test('it prints an empty line when no statusline is set and the status file is missing', async () => {
  setupTest();

  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    readStatusFile: () => {
      throw new Error('ENOENT: no such file or directory');
    },
    runChained: () => Promise.resolve(''),
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(printed).toStrictEqual(['']);
});

test("it reports the payload to the session's socket as a Statusline event", async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.sock);

  updateEnv('ATC_SOCKET', ctx.sock);
  updateEnv('ATC_SESSION_ID', 's1');

  await runStatusline('claude', {
    readStdin: () => Promise.resolve('{"session_id":"sl-1"}'),
    readStatusFile: () => '{}',
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

test("it renders the session's own state from the bridge inside a remote host", async () => {
  const ctx = setupTest();

  startStubSessionBridge(ctx.sock, (request) =>
    request['op'] === 'status.read' ? [{ id: request['id'], ok: true, state: 'needs_you' }] : null,
  );

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', ctx.sock);

  const printed: string[] = [];

  await runStatusline('', {
    readStdin: () => Promise.resolve('{}'),
    readStatusFile: () => JSON.stringify({ needs_you: 5 }),
    runChained: () => Promise.resolve(''),
    print: (line) => {
      printed.push(line);
    },
    exit: () => {},
  });

  expect(printed).toStrictEqual(['\u001B[1;31m● needs you\u001B[0m']);
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
    readStatusFile: () => '{}',
    runChained: () => Promise.reject(new Error('bash: ccline: command not found')),
    print: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  expect(codes).toStrictEqual([0]);
});
