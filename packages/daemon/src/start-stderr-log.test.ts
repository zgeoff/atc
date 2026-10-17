import { expect, onTestFinished, test } from 'bun:test';
import {
  closeSync,
  constants,
  createReadStream,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '@atc/protocol/wire';
import {
  registerTestCleanup,
  runCommand,
  sendLinesBeforeHandshake,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { getLogger, reset } from '@logtape/logtape';
import { startStderrLog } from './start-stderr-log';

async function setupTest() {
  const tmp = setupTempDir('atc-non-blocking-log-');
  const fifoPath = join(tmp.dir, 'stderr');

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  // stderr is a named pipe because a pipe from the spawn itself never fills: the
  // runtime reads it as it fills
  await runCommand(['mkfifo', fifoPath]);

  // The read end opens first and never blocks, so the write end opens at
  // once, and the daemon's writes block once the pipe is full. This end
  // never reads.
  const readEnd = openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK);

  registerTestCleanup(() => {
    closeSync(readEnd);
  });

  const writeEnd = openSync(fifoPath, constants.O_WRONLY);

  const closeWriteEnd = registerTestCleanup(() => {
    closeSync(writeEnd);
  });

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'testing', 'run-listener-daemon.ts')],
    {
      env: { ATC_TEST_DIR: tmp.dir, HOME: tmp.dir },
      stdout: 'pipe',
      stderr: writeEnd,
    },
  );

  registerTestCleanup(async () => {
    proc.kill('SIGKILL');

    await proc.exited;
  });

  // The daemon holds its own copy of the write end, and the pipe reports
  // its end only once every writer has closed.
  closeWriteEnd();

  const first = await proc.stdout.getReader().read();

  return {
    dir: tmp.dir,
    fifoPath,
    proc,
    port: Number(new TextDecoder().decode(first.value).trim()),
  };
}

test('it answers another client while a flood of refusals fills a stderr nobody reads', async () => {
  const ctx = await setupTest();

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
  const ctx = await setupTest();

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
  const ctx = await setupTest();

  const output: string[] = [];
  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  await waitFor(() => {
    expect(output.join('')).toStartWith('atc tcp event=listening ');
  });

  // The log holds 1024 lines behind the ones it is writing and drops past
  // that, however fast its reader reads, so the refusals go out in bursts
  // of 500 lines and the reader takes each burst before the next.
  for (let sent = 500; sent <= 2000; sent += 500) {
    await sendLinesBeforeHandshake(ctx.port, 500);

    await waitFor(() => {
      expect(output.join('').split('\n')).toHaveLength(sent + 2);
    });
  }

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
  const ctx = await setupTest();

  await sendLinesBeforeHandshake(ctx.port, 3000);

  const running = Bun.peek.status(ctx.proc.exited);

  ctx.proc.kill('SIGTERM');

  const exitCode = await ctx.proc.exited;

  expect(running).toBe('pending');
  expect(exitCode).toBe(0);
  expect(ctx.proc.signalCode).toBeNull();
});

test('it writes every line it holds at SIGTERM, and the count of the ones it dropped, to a stderr reader that starts to read after it', async () => {
  const ctx = await setupTest();

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

test('it resolves a second stop that overlaps the first only once every line it holds is written', async () => {
  const tmp = setupTempDir('atc-stderr-log-');
  const outputPath = join(tmp.dir, 'stderr');
  const fd = openSync(outputPath, 'w');

  onTestFinished(() => {
    closeSync(fd);
  });

  const log = await startStderrLog(fd);

  onTestFinished(() => reset());

  for (let count = 1; count <= 100; count++) {
    const line = `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}`;

    getLogger(['atc', 'tcp']).info('{line}', { line });
  }

  const first = log.stop();

  await log.stop();

  const written = readFileSync(outputPath, 'utf8');

  await first;

  expect(written).toBe(
    Array.from(
      { length: 100 },
      (_, index) =>
        `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(index + 1)}\n`,
    ).join(''),
  );
});
