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
import { openDaemonClient } from '@atc/protocol/client';
import {
  registerTestCleanup,
  runCommand,
  sendLinesBeforeHandshake,
  setupTempDir,
  waitFor,
  writeUntilPipeFull,
} from '@atc/test-utils';
import { getLogger, reset } from '@logtape/logtape';
import { startStderrLog } from './start-stderr-log';

async function setupTest() {
  const tmp = setupTempDir('atc-non-blocking-log-');
  const fifoPath = join(tmp.path, 'stderr');

  // The listener refuses to start without a token file.
  writeFileSync(join(tmp.path, 'gateway-token'), `${'a'.repeat(32)}\n`);

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

  // Starts the daemon with the pipe as its stderr, and returns it with the
  // port it listens on.
  const startListenerDaemon = async () => {
    const writeEnd = openSync(fifoPath, constants.O_WRONLY);

    const closeWriteEnd = registerTestCleanup(() => {
      closeSync(writeEnd);
    });

    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'testing', 'run-listener-daemon.ts')],
      {
        env: { ATC_TEST_DIR: tmp.path, HOME: tmp.path },
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

    return { proc, port: Number(new TextDecoder().decode(first.value).trim()) };
  };

  return { dir: tmp.path, fifoPath, startListenerDaemon };
}

test('it answers another client while a flood of refusals fills a stderr nobody reads', async () => {
  const ctx = await setupTest();

  writeUntilPipeFull(ctx.fifoPath);

  const daemon = await ctx.startListenerDaemon();

  await sendLinesBeforeHandshake(daemon.port, 100);

  const client = await openDaemonClient(join(ctx.dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const pong = await client.sendRequest('daemon.ping', {});

  expect(pong).toStrictEqual({});
});

test('it logs how many lines it dropped once the stderr reader reads again', async () => {
  const ctx = await setupTest();

  // Filled before the daemon starts, so a reader takes these bytes first.
  const filledBytes = writeUntilPipeFull(ctx.fifoPath);

  const daemon = await ctx.startListenerDaemon();

  const output: string[] = [];

  await sendLinesBeforeHandshake(daemon.port, 100);

  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  // The log writes the count of the lines it dropped ahead of the next line
  // it writes, so each check sends one more refusal.
  await waitFor(async () => {
    await sendLinesBeforeHandshake(daemon.port, 1);

    expect(output.join('').slice(filledBytes)).toMatch(/^atc log dropped=\d+$/mu);
  });
});

test('it delivers every line to a stderr reader that keeps reading', async () => {
  const ctx = await setupTest();
  const daemon = await ctx.startListenerDaemon();

  const output: string[] = [];
  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  await waitFor(() => {
    expect(output.join('')).toStartWith('atc tcp event=listening ');
  });

  // The log holds 32 lines behind the ones it is writing and drops past
  // that, however fast its reader reads, so the refusals go out in bursts
  // of 16 lines and the reader takes each burst before the next.
  for (let sent = 16; sent <= 64; sent += 16) {
    await sendLinesBeforeHandshake(daemon.port, 16);

    await waitFor(() => {
      expect(output.join('').split('\n')).toHaveLength(sent + 2);
    });
  }

  await waitFor(() => {
    expect(output.join('').split('\n')).toStrictEqual([
      expect.toStartWith('atc tcp event=listening '),
      ...Array.from(
        { length: 64 },
        () => 'atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=1',
      ),
      '',
    ]);
  });
});

test('it exits cleanly on SIGTERM while a flood of refusals fills the unread stderr', async () => {
  const ctx = await setupTest();

  writeUntilPipeFull(ctx.fifoPath);

  const daemon = await ctx.startListenerDaemon();

  await sendLinesBeforeHandshake(daemon.port, 100);

  const running = Bun.peek.status(daemon.proc.exited);

  daemon.proc.kill('SIGTERM');

  const exitCode = await daemon.proc.exited;

  expect(running).toBe('pending');
  expect(exitCode).toBe(0);
  expect(daemon.proc.signalCode).toBeNull();
});

test('it writes every line it holds at SIGTERM, and the count of the ones it dropped, to a stderr reader that starts to read after it', async () => {
  const ctx = await setupTest();

  // Filled before the daemon starts, so a reader takes these bytes first.
  const filledBytes = writeUntilPipeFull(ctx.fifoPath);

  const daemon = await ctx.startListenerDaemon();

  const output: string[] = [];

  await sendLinesBeforeHandshake(daemon.port, 100);

  daemon.proc.kill('SIGTERM');

  const reader = createReadStream(ctx.fifoPath, { encoding: 'utf8' });

  onTestFinished(() => reader.destroy());

  reader.on('data', (chunk) => {
    output.push(String(chunk));
  });

  const ended = new Promise((resolve) => {
    reader.on('end', resolve);
  });

  const exitCode = await daemon.proc.exited;

  await ended;

  // Every refusal arrives as a line of its own or is counted on a dropped
  // line.
  const lines = output.join('').slice(filledBytes).split('\n');

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
    total: 100,
  });
});

test('it resolves a second stop that overlaps the first only once every line it holds is written', async () => {
  const tmp = setupTempDir('atc-stderr-log-');
  const outputPath = join(tmp.path, 'stderr');
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
