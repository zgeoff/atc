import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-mcp-grok-'));
  const lines: string[] = [];

  // The reporter the script reports through sends one line per connection
  // here.
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

  const bin = createStubBin(tmp.dir, 'grok', buildStubMCPGrok());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    bin,
    lines,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints its marker and arguments, then stays up', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin, '--model', 'grok-5'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const first = await proc.stdout.getReader().read();

  expect(new TextDecoder().decode(first.value)).toBe('FAKE_GROK_UP args: --model grok-5\n');
  expect(proc.exitCode).toBeNull();
});

test('it reports session_start with its session id and working directory through the reporter', async () => {
  using ctx = setupTest();

  const proc = Bun.spawn([ctx.bin], {
    cwd: ctx.dir,
    env: {
      HOME: ctx.dir,
      PATH: '/usr/bin:/bin',
      ATC_SOCKET: join(ctx.dir, 'report.sock'),
      ATC_SESSION_ID: 's-1',
    },
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
  });

  const line = await waitFor(() => {
    expect(ctx.lines).toBeArrayOfSize(1);

    return ctx.lines[0];
  });

  expect(JSON.parse(line ?? '')).toStrictEqual({
    atcId: 's-1',
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'fake-grok-1', cwd: ctx.dir },
  });
});
