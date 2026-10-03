import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Listener {
  readonly sock: string;
  readonly waitForLine: () => Promise<string>;
}

function setupListener(): Listener {
  const dir = mkdtempSync(join(tmpdir(), 'atc-hook-report-'));
  const sock = join(dir, 'reporter.sock');
  const received = Promise.withResolvers<string>();
  let chunks = '';

  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, buf) {
        chunks += buf.toString();

        if (chunks.includes('\n')) {
          received.resolve(chunks);
          socket.end();
        }
      },
      open() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  });

  return { sock, waitForLine: () => received.promise };
}

function runReporter(
  sock: string,
  payload: Readonly<Record<string, unknown>>,
  flags: readonly string[] = [],
): Promise<number> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'hook-report', ...flags],
    {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      env: { ...process.env, ATC_SOCKET: sock, ATC_SESSION_ID: 's1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  return proc.exited;
}

test('it forwards a Claude SessionStart envelope as SessionStart', async () => {
  const listener = setupListener();
  const payload = { hook_event_name: 'SessionStart', session_id: 'claude-1' };

  const [code, line] = await Promise.all([
    runReporter(listener.sock, payload),
    listener.waitForLine(),
  ]);

  expect(code).toBe(0);
  expect(JSON.parse(line)).toStrictEqual({ atcId: 's1', event: 'SessionStart', payload });
});

test('it forwards a Grok session_start envelope as SessionStart', async () => {
  const listener = setupListener();
  const payload = { hookEventName: 'session_start', sessionId: 'grok-1' };

  const [code, line] = await Promise.all([
    runReporter(listener.sock, payload),
    listener.waitForLine(),
  ]);

  expect(code).toBe(0);
  expect(JSON.parse(line)).toStrictEqual({ atcId: 's1', event: 'SessionStart', payload });
});

test('it exits 0 when both event name keys are missing', async () => {
  const listener = setupListener();
  const payload = { sessionId: 'grok-1' };

  const [code, line] = await Promise.all([
    runReporter(listener.sock, payload),
    listener.waitForLine(),
  ]);

  expect(code).toBe(0);
  expect(JSON.parse(line)).toStrictEqual({ atcId: 's1', payload });
});

test('it forwards the agent its command line gives it', async () => {
  const listener = setupListener();
  const payload = { hook_event_name: 'Stop', session_id: 'codex-1' };

  const [code, line] = await Promise.all([
    runReporter(listener.sock, payload, ['--agent', 'codex']),
    listener.waitForLine(),
  ]);

  expect(code).toBe(0);
  expect(JSON.parse(line)).toStrictEqual({ atcId: 's1', agent: 'codex', event: 'Stop', payload });
});
