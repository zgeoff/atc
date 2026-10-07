import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { sendReport } from '../shared/report';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

/**
 * A stub reporter socket in a temp directory, which also holds any other
 * socket a test needs. Disposal stops the stub and removes the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-reporter-'));
  const path = join(tmp.dir, 'reporter.sock');
  const reporter = stack.use(startStubReporterSocket(path));
  const owned = stack.move();

  return {
    dir: tmp.dir,
    path,
    reporter,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it collects each line a sender writes without its newline', async () => {
  using ctx = setupTest();

  await sendReport(ctx.path, 'one\ntwo\n', 2000);

  await waitFor(() => {
    expect(ctx.reporter.lines).toStrictEqual(['one', 'two']);
  });
});

test('it joins a line that arrives across several writes', async () => {
  using ctx = setupTest();

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"par');

  await waitFor(() => {
    expect(ctx.reporter.reads).toBe(1);
  });

  socket.write('tial":1}\n');

  await waitFor(() => {
    expect(ctx.reporter.lines).toStrictEqual(['{"partial":1}']);
  });
});

test('it counts each read it takes from a connection', async () => {
  using ctx = setupTest();

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"par');

  await waitFor(() => {
    expect(ctx.reporter.reads).toBe(1);
  });
});

test('it collects nothing from a line that never ends', async () => {
  using ctx = setupTest();

  await sendReport(ctx.path, 'unfinished', 2000);
  await sendReport(ctx.path, 'done\n', 2000);

  await waitFor(() => {
    expect(ctx.reporter.lines).toStrictEqual(['done']);
  });
});

test('it resolves the wait with the first line to arrive', async () => {
  using ctx = setupTest();

  await sendReport(ctx.path, 'first\n', 2000);
  await sendReport(ctx.path, 'second\n', 2000);

  const line = await ctx.reporter.waitForLine();

  expect(line).toBe('first');
});

test('it rejects the wait naming the socket when no line arrives in time', () => {
  using ctx = setupTest();

  expect(ctx.reporter.waitForLine(50)).rejects.toThrowWithMessage(
    Error,
    `no line has arrived at ${ctx.path}`,
  );
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  const path = join(ctx.dir, 'disposed.sock');

  startStubReporterSocket(path)[Symbol.dispose]();

  expect(Bun.connect({ unix: path, socket: { data() {} } })).rejects.toThrow();
});
