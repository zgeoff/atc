import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, constants, createReadStream, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { sendLinesBeforeHandshake } from '../test-utils/send-lines-before-handshake';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';

/**
 * A daemon in a process of its own whose TCP listener logs every refusal
 * on a line of its own to the daemon's stderr, a named pipe at `fifoPath`
 * that nothing reads until the test opens it. A pipe from the spawn itself
 * would not do: the runtime reads those as they fill. The daemon prints
 * the port its listener bound, which `port` holds.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-non-blocking-log-'));
  const fifoPath = join(tmp.dir, 'stderr');

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  Bun.spawnSync(['mkfifo', fifoPath]);

  // The read end opens first and never blocks, so the write end opens at
  // once, and the daemon's writes block once the pipe is full. This end
  // never reads.
  const readEnd = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);

  stack.defer(() => {
    closeSync(readEnd);
  });

  const writeEnd = openSync(fifoPath, constants.O_WRONLY);

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'test-utils', 'run-listener-daemon.ts')],
    {
      env: { ATC_TEST_DIR: tmp.dir, HOME: tmp.dir },
      stdout: 'pipe',
      stderr: writeEnd,
    },
  );

  stack.defer(async () => {
    proc.kill('SIGKILL');

    await proc.exited;
  });

  closeSync(writeEnd);

  const first = await proc.stdout.getReader().read();

  const owned = stack.move();

  return {
    dir: tmp.dir,
    fifoPath,
    proc,
    port: Number(new TextDecoder().decode(first.value).trim()),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it answers another client while a flood of refusals fills a stderr nobody reads', async () => {
  await using ctx = await setupTest();

  await sendLinesBeforeHandshake(ctx.port, 3000);

  const client = await DaemonClient.open(join(ctx.dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const pong = await client.sendRequest('daemon.ping', {});

  expect(pong).toStrictEqual({});
});

test('it logs how many lines it dropped once the stderr reader reads again', async () => {
  await using ctx = await setupTest();

  const output: string[] = [];

  await sendLinesBeforeHandshake(ctx.port, 3000);

  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  await waitFor(() => {
    expect(output.join('')).toMatch(/^atc log dropped=\d+$/mu);
  });
});

test('it delivers every line to a stderr reader that keeps reading', async () => {
  await using ctx = await setupTest();

  const output: string[] = [];
  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  await sendLinesBeforeHandshake(ctx.port, 2000);

  await waitFor(() => {
    expect(output.join('').split('\n')).toStrictEqual([
      expect.toStartWith('atc tcp event=listening '),
      ...Array.from(
        { length: 2000 },
        () => 'atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=1',
      ),
      '',
    ]);
  });
});

test('it exits cleanly on SIGTERM while a flood of refusals fills the unread stderr', async () => {
  await using ctx = await setupTest();

  await sendLinesBeforeHandshake(ctx.port, 3000);

  ctx.proc.kill('SIGTERM');

  const exitCode = await ctx.proc.exited;

  expect({ exitCode, signalCode: ctx.proc.signalCode }).toStrictEqual({
    exitCode: 0,
    signalCode: null,
  });
});

test('it writes every line it holds at SIGTERM, and the count of the ones it dropped, to a stderr reader that starts to read after it', async () => {
  await using ctx = await setupTest();

  const output: string[] = [];

  await sendLinesBeforeHandshake(ctx.port, 3000);

  ctx.proc.kill('SIGTERM');

  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  const ended = new Promise((resolve) => {
    reader.on('end', resolve);
  });

  const exitCode = await ctx.proc.exited;

  await ended;

  // Every refusal arrives as a line of its own or is counted on a dropped
  // line, however much of the flood the host's pipe took before the log
  // started to queue and drop.
  const lines = output.join('').split('\n');

  expect({
    exitCode,
    first: lines[0],
    middle: lines.slice(1, -1),
    last: lines.at(-1),
    total:
      lines.filter(
        (line) =>
          line === 'atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=1',
      ).length +
      lines
        .filter((line) => line.startsWith('atc log dropped='))
        .reduce((sum, line) => sum + Number(line.slice('atc log dropped='.length)), 0),
  }).toStrictEqual({
    exitCode: 0,
    first: expect.toStartWith('atc tcp event=listening '),
    middle: expect.toSatisfyAll((line: string) =>
      /^(?:atc tcp event=handshake_refused peer=127\.0\.0\.1 reason=unexpected_line count=1|atc log dropped=\d+)$/u.test(
        line,
      ),
    ),
    last: '',
    total: 3000,
  });
});
