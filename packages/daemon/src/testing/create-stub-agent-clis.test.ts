import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir, startStubReporterSocket, waitFor } from '@atc/test-utils';
import { buildStubMemoryProvider } from './build-stub-memory-provider';
import { createStubAgentCLIs } from './create-stub-agent-clis';

// The stand-in on a provider of its own beside a reporter socket, and a
// start that spawns one session of an agent the way a launch does.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-agent-clis-');
  const agents = createStubAgentCLIs(temporaryDirectory.path);
  const provider = buildStubMemoryProvider({ onStart: agents.start });
  const socketPath = join(temporaryDirectory.path, 'reporter.sock');
  const reporter = startStubReporterSocket(socketPath);
  const settingsPath = join(temporaryDirectory.path, 'settings.json');

  const start = (bin: string, args: readonly string[] = []) => {
    const harness = provider.spawnHarness({
      session: 's-1',
      host: 's-1',
      bin,
      args: [...args],
      cwd: '/work',
      env: { ATC_SESSION_ID: 's-1', ATC_SOCKET: socketPath },
      cols: 80,
      rows: 24,
    });

    const output = { text: '' };

    harness.onData((data) => {
      output.text += data;
    });

    return { harness, output };
  };

  return { directory: temporaryDirectory.path, agents, reporter, settingsPath, start };
}

test('it reports a Claude start and its permission prompt under the agent its hook command names', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: "atc hook-report --agent='zai'" }] }],
      },
    }),
  );

  ctx.start(ctx.agents.bins.claude, ['--settings', ctx.settingsPath]);

  await waitFor(() => {
    expect(ctx.reporter.lines).toHaveLength(2);
  });

  expect(ctx.reporter.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      agent: 'zai',
      event: 'SessionStart',
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'fake-1',
        transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
      },
    },
    {
      atcId: 's-1',
      agent: 'zai',
      event: 'Notification',
      payload: {
        hook_event_name: 'Notification',
        session_id: 'fake-1',
        message: 'needs permission',
      },
    },
  ]);
});

test('it reports a Grok start with the event name the reporter normalizes', async () => {
  const ctx = setupTest();

  ctx.start(ctx.agents.bins.grok);

  await waitFor(() => {
    expect(ctx.reporter.lines).toHaveLength(2);
  });

  expect(JSON.parse(ctx.reporter.lines[0] ?? '')).toStrictEqual({
    atcId: 's-1',
    agent: 'grok',
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: '/work' },
  });
});

test('it reports a Codex start and its finished turn', async () => {
  const ctx = setupTest();

  ctx.start(ctx.agents.bins.codex);

  await waitFor(() => {
    expect(ctx.reporter.lines).toHaveLength(2);
  });

  expect(ctx.reporter.lines.map((line): unknown => JSON.parse(line))).toMatchObject([
    { agent: 'codex', event: 'SessionStart', payload: { session_id: 'fake-codex-1' } },
    { agent: 'codex', event: 'Stop', payload: { last_assistant_message: 'pong' } },
  ]);
});

test('it reports the loaded events in place of the prompt for the next session only', async () => {
  const ctx = setupTest();

  ctx.agents.loadEvents('grok', [
    { hookEventName: 'stop', sessionId: 'fake-grok-1', stopReason: 'end_turn' },
  ]);

  ctx.start(ctx.agents.bins.grok);

  await waitFor(() => {
    expect(ctx.reporter.lines).toHaveLength(2);
  });

  ctx.start(ctx.agents.bins.grok);

  await waitFor(() => {
    expect(ctx.reporter.lines).toHaveLength(4);
  });

  expect(ctx.reporter.lines.map((line): unknown => JSON.parse(line))).toMatchObject([
    { event: 'SessionStart' },
    { event: 'Stop' },
    { event: 'SessionStart' },
    { event: 'Notification' },
  ]);
});

test('it paints the banner with its arguments and reports nothing for a held start', async () => {
  const ctx = setupTest();

  ctx.agents.holdStart('codex');

  const session = ctx.start(ctx.agents.bins.codex, ['--yolo']);

  await waitFor(() => {
    expect(session.output.text).toBe('FAKE_CODEX_UP args: --yolo\r\n');
  });

  const sent = await ctx.agents.sessions[0]?.report({ hook_event_name: 'Stop' });

  await waitFor(() => {
    expect(ctx.reporter.lines).not.toBeEmpty();
  });

  expect(sent).toBeTrue();

  expect(ctx.reporter.lines.map((line): unknown => JSON.parse(line))).toMatchObject([
    { event: 'Stop' },
  ]);
});

test('it reports the daemon session id as the Claude session id once told to use its own', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'atc hook-report --agent=claude' }] }],
      },
    }),
  );

  ctx.agents.useOwnID();
  ctx.start(ctx.agents.bins.claude, ['--settings', ctx.settingsPath]);

  await waitFor(() => {
    expect(ctx.reporter.lines).not.toBeEmpty();
  });

  expect(JSON.parse(ctx.reporter.lines[0] ?? '')).toMatchObject({
    payload: { session_id: 's-1' },
  });
});

test('it echoes each line a Claude session reads and records it', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'atc hook-report --agent=claude' }] }],
      },
    }),
  );

  ctx.agents.holdStart('claude');

  const session = ctx.start(ctx.agents.bins.claude, ['--settings', ctx.settingsPath]);

  session.harness.write('hello\r');
  session.harness.write('wor');
  session.harness.write('ld\n');

  expect(ctx.agents.sessions[0]?.received).toStrictEqual(['hello', 'world']);
  expect(session.output.text).toBe('GOT:hello\r\nGOT:world\r\n');
});

test('it resolves a report false once the daemon socket is gone', async () => {
  const ctx = setupTest();

  ctx.agents.holdStart('grok');
  ctx.start(ctx.agents.bins.grok);
  ctx.reporter.stop();

  const sent = await ctx.agents.sessions[0]?.report({ hookEventName: 'stop' });

  expect(sent).toBeFalse();
});

test('it refuses a spawn of a binary that is none of its agents', () => {
  const ctx = setupTest();

  expect(() => ctx.start('/usr/bin/true')).toThrowWithMessage(
    Error,
    'the stand-in runs no agent at /usr/bin/true',
  );
});

test('it writes agent binaries that exit 1 when run', async () => {
  const ctx = setupTest();
  const ran = Bun.spawn([ctx.agents.bins.claude], { stderr: 'pipe' });

  const exitCode = await ran.exited;

  expect(exitCode).toBe(1);
});
