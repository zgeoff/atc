import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIGrok } from './build-stub-tui-grok';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// A home holding the stub and a reporter socket that keeps one line per
// connection; `start` runs the stub there and captures what it prints.
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-tui-grok-'));
  const lines: string[] = [];

  const listener = Bun.listen<{ buffer: string }>({
    unix: join(tmp.dir, 'report.sock'),
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
      },
      close(socket) {
        lines.push(socket.data.buffer.trimEnd());
      },
    },
  });

  stack.defer(() => {
    listener.stop(true);
  });

  const bin = createStubBin(tmp.dir, 'grok', buildStubTUIGrok());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    lines,
    start(args: readonly string[]) {
      const proc = Bun.spawn([bin, ...args], {
        env: {
          HOME: tmp.dir,
          PATH: '/usr/bin:/bin',
          ATC_SOCKET: join(tmp.dir, 'report.sock'),
          ATC_SESSION_ID: 's-1',
        },
        cwd: tmp.dir,
        stdin: 'pipe',
        stdout: 'pipe',
      });

      onTestFinished(() => {
        proc.kill();
      });

      let out = '';

      void (async () => {
        for await (const chunk of proc.stdout) {
          out += Buffer.from(chunk).toString();
        }
      })();

      return { proc, read: () => out };
    },
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints its marker with its arguments and then its hooks-done marker', async () => {
  using ctx = setupTest();

  const run = ctx.start(['--no-leader']);

  await waitFor(() => {
    expect(run.read()).toBe('FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\n');
  });
});

test('it reports its session start and then a permission prompt through the reporter', async () => {
  using ctx = setupTest();

  ctx.start([]);

  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(ctx.lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      atcId: 's-1',
      event: 'SessionStart',
      payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.dir },
    },
    {
      atcId: 's-1',
      event: 'Notification',
      payload: {
        hookEventName: 'notification',
        sessionId: 'fake-grok-1',
        notificationType: 'permission_prompt',
        message: 'allow edit?',
      },
    },
  ]);
});

test('it reports the events file in place of the permission prompt', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  ctx.start([]);

  // The listener records a report once its connection closes, so the test
  // waits for both reports rather than the stub's done line.
  await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(2);
  });

  expect(JSON.parse(ctx.lines[1] ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'Stop',
    payload: { hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' },
  });
});

test('it reports nothing when the hold-start file exists', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-grok-hold-start'), '');

  const run = ctx.start([]);

  void run.proc.stdin.write('ping\n');
  void run.proc.stdin.flush();

  await waitFor(() => {
    expect(run.read()).toInclude('GOT:ping');
  });

  expect(ctx.lines).toStrictEqual([]);
});

test('it defers its session start until the defer file goes', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-grok-defer-start'), '');

  const run = ctx.start([]);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'fake-grok-start-deferred'))).toBe(true);
  });

  const reportedWhileDeferred = ctx.lines.length;

  rmSync(join(ctx.dir, 'fake-grok-defer-start'));

  // The listener records a report once its connection closes, which can
  // land after the stub prints its done line, so the wait covers both.
  await waitFor(() => {
    expect({
      done: run.read().includes('FAKE_GROK_HOOKS_DONE'),
      reported: ctx.lines.length,
    }).toStrictEqual({
      done: true,
      reported: 2,
    });
  });

  expect(reportedWhileDeferred).toBe(0);
});
