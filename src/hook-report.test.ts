import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubReporterSocket } from './test-utils/start-stub-reporter-socket';

/**
 * A stub of the daemon's reporter socket in a temp directory, for the
 * hook-report subcommand to send its line to. Disposal stops the stub and
 * removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-hook-report-'));
  const sock = join(tmp.dir, 'reporter.sock');
  const reporter = stack.use(startStubReporterSocket(sock));
  const owned = stack.move();

  return {
    sock,
    reporter,
    cli: join(import.meta.dir, 'cli.ts'),
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it forwards a Claude SessionStart envelope as SessionStart', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([process.execPath, ctx.cli, 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'claude-1' }),
    ),
    env: { ...process.env, ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const [code, line] = await Promise.all([proc.exited, ctx.reporter.waitForLine()]);

  expect({ code, line: JSON.parse(line) as unknown }).toStrictEqual({
    code: 0,
    line: {
      atcId: 's1',
      event: 'SessionStart',
      payload: { hook_event_name: 'SessionStart', session_id: 'claude-1' },
    },
  });
});

test('it forwards a Grok session_start envelope as SessionStart', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([process.execPath, ctx.cli, 'hook-report'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hookEventName: 'session_start', sessionId: 'grok-1' }),
    ),
    env: { ...process.env, ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const [code, line] = await Promise.all([proc.exited, ctx.reporter.waitForLine()]);

  expect({ code, line: JSON.parse(line) as unknown }).toStrictEqual({
    code: 0,
    line: {
      atcId: 's1',
      event: 'SessionStart',
      payload: { hookEventName: 'session_start', sessionId: 'grok-1' },
    },
  });
});

test('it exits 0 and forwards no event name when both event name keys are missing', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([process.execPath, ctx.cli, 'hook-report'], {
    stdin: new TextEncoder().encode(JSON.stringify({ sessionId: 'grok-1' })),
    env: { ...process.env, ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const [code, line] = await Promise.all([proc.exited, ctx.reporter.waitForLine()]);

  expect({ code, line: JSON.parse(line) as unknown }).toStrictEqual({
    code: 0,
    line: { atcId: 's1', payload: { sessionId: 'grok-1' } },
  });
});

test('it forwards the agent its command line gives it', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([process.execPath, ctx.cli, 'hook-report', '--agent', 'codex'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'codex-1' }),
    ),
    env: { ...process.env, ATC_SOCKET: ctx.sock, ATC_SESSION_ID: 's1' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const [code, line] = await Promise.all([proc.exited, ctx.reporter.waitForLine()]);

  expect({ code, line: JSON.parse(line) as unknown }).toStrictEqual({
    code: 0,
    line: {
      atcId: 's1',
      agent: 'codex',
      event: 'Stop',
      payload: { hook_event_name: 'Stop', session_id: 'codex-1' },
    },
  });
});
