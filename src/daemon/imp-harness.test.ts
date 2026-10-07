import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import type { HarnessAttachment, HarnessExit } from './execution-provider';
import { ImpHarness } from './imp-harness';

/**
 * A stub imp port and the script a harness on it runs, in a temp
 * directory of the test's own. The script prints its pid and the terminal
 * size it started at, echoes each line it reads, prints the terminal size
 * on `size`, exits 3 on `quit`, and on `later` prints 300000 bytes, more
 * than impd's ring keeps, once a line is written to the `burst` pipe in
 * `dir`.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-imp-harness-'));
  const port = stack.use(buildStubImpPort());

  // The script's `later` burst waits on this pipe.
  Bun.spawnSync(['mkfifo', join(tmp.dir, 'burst')]);

  const script = createStubBin(
    tmp.dir,
    'harness',
    `#!/usr/bin/env bash
echo "UP:$$ START:$(stty size)"
while read -r line; do
  if [ "$line" = "later" ]; then
    (cat "${join(tmp.dir, 'burst')}" > /dev/null; head -c 300000 /dev/zero | tr '\\0' 'x'; echo; echo "BURST_DONE") &
  fi
  if [ "$line" = "size" ]; then echo "SIZE:$(stty size)"; fi
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line"
done
`,
  );

  const owned = stack.move();

  return {
    dir: tmp.dir,
    port,
    script,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it reconnects after impd drops a send and resumes after the last byte it has', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const attachments: HarnessAttachment[] = [];

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  harness.write('one\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:one');
  });

  const end = ctx.port.getEnd('imp-a', 's1');

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  harness.write('two\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:two');
  });

  expect(ctx.port.sessionRequests[1]).toMatchObject({
    kind: 'attach',
    wake: false,
    resumeFrom: { executionGeneration: ctx.port.getGeneration('imp-a', 's1'), offset: end },
  });

  expect(attachments).toStrictEqual(['attached', 'reattaching', 'attached']);
  expect(exits).toBeEmpty();
});

test('it drops the bytes a resume repeats below its high-water offset', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const attachments: HarnessAttachment[] = [];

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.resumeOverlap = 4096;

  harness.write('one\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:one');
  });

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  harness.write('two\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:two');
  });

  expect(output.join('').split('GOT:one')).toHaveLength(2);
  expect(output.join('').split('UP:')).toHaveLength(2);
});

test('it does a fresh attach that clears the screen when the resume finds a gap', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  harness.write('later\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:later');
  });

  const end = ctx.port.getEnd('imp-a', 's1');

  ctx.port.startAnswerHold();
  ctx.port.stopConnection('imp-a', 's1', 1011);

  writeFileSync(join(ctx.dir, 'burst'), 'go\n');

  await waitFor(() => {
    expect(ctx.port.getEnd('imp-a', 's1') - end).toBeGreaterThan(300_000);
  });

  ctx.port.stopAnswerHold();

  await waitFor(() => {
    expect(output.join('')).toInclude('BURST_DONE');
  });

  expect(
    ctx.port.sessionRequests.map((request) => [request.kind, 'resumeFrom' in request]),
  ).toStrictEqual([
    ['start', false],
    ['attach', true],
    ['attach', false],
  ]);

  expect(output.join('')).toInclude('\u001B[0m\u001B[H\u001B[2J');
  expect(exits).toBeEmpty();
});

test('it does a fresh attach when impd refuses its resume offset', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const attachments: HarnessAttachment[] = [];

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setNextSessionFailure('INVALID_RESUME', { end: 0, bufferStart: 0 });
  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(attachments.slice(1)).toStrictEqual(['reattaching', 'reattaching', 'attached']);
  });

  harness.write('three\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:three');
  });

  expect(
    ctx.port.sessionRequests.map((request) => [request.kind, 'resumeFrom' in request]),
  ).toStrictEqual([
    ['start', false],
    ['attach', true],
    ['attach', false],
  ]);

  expect(output.join('')).toInclude('\u001B[0m\u001B[H\u001B[2J');
});

test('it takes the session back from another connection that takes it over', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  const other = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  expect(other.outcome).resolves.toMatchObject({ kind: 'detached', reason: 'taken_over' });
  expect(ctx.port.sessionRequests[2]).toMatchObject({ kind: 'attach', wake: false });
});

test('it carries input once it takes the session back from another connection', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  const other = ctx.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  await other.outcome;

  harness.write('four\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:four');
  });
});

test('it ends a harness whose imp booted cold with the cause of the first boot after its own', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.bootImpCold('imp-a', 'watchdog');

  await waitFor(() => {
    expect(exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'imp rebooted (watchdog)' },
    ]);
  });
});

test('it ends a harness without a boot id as ended with the cause unknown', async () => {
  const ready = Promise.withResolvers<void>();

  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      ready: ready.promise,
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  ctx.port.continuity = 'none';

  ready.resolve();

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.bootImpCold('imp-a', 'watchdog');

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' }]);
  });
});

test('it ends with the kept exit code of its own generation when impd no longer holds it', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setNextSessionFailure('NO_SESSION', {
    bootId: ctx.port.getBootID('imp-a'),
    coldBoots: [],
    previous: {
      executionGeneration: ctx.port.getGeneration('imp-a', 's1'),
      end: 10,
      exitCode: 7,
    },
  });

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 7, reason: 'exited' }]);
  });
});

test('it ends with the refusal message in the detail when impd refuses without a code', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setNextSessionFailure(null, undefined, 'the sentinel refusal reason');
  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      {
        exitCode: 1,
        reason: 'ended',
        detail: 'imp refused the session (error): the sentinel refusal reason',
      },
    ]);
  });
});

test('it redacts credential-shaped runs from a refusal message it shows', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setNextSessionFailure(
    null,
    undefined,
    'proxy rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789 and key 0123456789abcdef0123456789abcdef',
  );

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      {
        exitCode: 1,
        reason: 'ended',
        detail:
          'imp refused the session (error): proxy rejected Bearer [redacted] and key [redacted]',
      },
    ]);
  });
});

test('it redacts short credentials in URL, header, and authorization shapes it shows', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setNextSessionFailure(
    null,
    undefined,
    'dial failed: https://alice:demo-pass@api.example.test/v1?api_key=demo-secret with x-api-key: demo-secret and Authorization: Basic ZGVtbzpwYXNz',
  );

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      {
        exitCode: 1,
        reason: 'ended',
        detail:
          'imp refused the session (error): dial failed: https://[redacted]@api.example.test/v1?api_key=[redacted] with x-api-key: [redacted] and Authorization: [redacted]',
      },
    ]);
  });
});

test('it never sends a resume offset to a session whose agent carries none', async () => {
  const ready = Promise.withResolvers<void>();

  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      ready: ready.promise,
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const attachments: HarnessAttachment[] = [];

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  ctx.port.continuity = 'none';

  ready.resolve();

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  harness.write('five\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:five');
  });

  expect(ctx.port.sessionRequests).toSatisfyAll(
    (request: Readonly<Record<string, unknown>>) => !('resumeFrom' in request),
  );

  expect(output.join('')).toInclude('\u001B[0m\u001B[H\u001B[2J');
});

test('it never sends a resume offset when impd carries no offsets', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  const output: string[] = [];
  const attachments: HarnessAttachment[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: false,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.stopConnection('imp-b', 's2', 1011);

  await waitFor(() => {
    expect(attachments).toStrictEqual(['attached', 'reattaching', 'attached']);
  });

  harness.write('six\r');

  await waitFor(() => {
    expect(output.join('')).toInclude('GOT:six');
  });

  expect(ctx.port.sessionRequests.filter((request) => request.name === 'imp-b')).toSatisfyAll(
    (request: Readonly<Record<string, unknown>>) => !('resumeFrom' in request),
  );
});

test('it reports a harness whose imp another owner put to sleep as suspended, without waking it', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.suspendWithForce('imp-a');

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 0, reason: 'suspended' }]);
  });

  expect(ctx.port.sessionRequests[1]).toMatchObject({ kind: 'attach', wake: false });
  expect(ctx.port.findState('imp-a')).toBe('sleeping');
});

test('it confirms the exit of a killed harness once impd reports its process exited', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  harness.kill();

  const exited = await harness.waitForExit(5000);

  expect(exited).toBeTrue();
});

test('it reports no exit for a running harness whose wait runs out', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  const exited = await harness.waitForExit(0);

  expect(exited).toBeFalse();
});

test('it reports no exit for a harness whose imp went to sleep with the process inside', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  const waited = harness.waitForExit(5000);

  ctx.port.suspendWithForce('imp-a');

  const exited = await waited;

  expect(exited).toBeFalse();
});

test('it counts connections impd drops before they start, and ends once its reconnects run out', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  ctx.port.setSessionDrops(10, 1011);
  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'imp connection closed (code 1011)' },
    ]);
  });

  expect(ctx.port.sessionRequests).toHaveLength(5);
});

test('it ends once its reconnects run out when a listener throws on every connection that starts', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  harness.onAttachment((attachment) => {
    if (attachment === 'attached') {
      throw new Error('write EPIPE');
    }
  });

  ctx.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      {
        exitCode: 1,
        reason: 'ended',
        detail: 'imp connection failed in the daemon (write EPIPE)',
      },
    ]);
  });

  expect(ctx.port.sessionRequests).toHaveLength(5);
});

test('it starts at the size a resize asked for while its host was still readying', async () => {
  const ready = Promise.withResolvers<void>();

  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      ready: ready.promise,
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  harness.resize(100, 40);
  ready.resolve();

  await waitFor(() => {
    expect(output.join('')).toInclude('START:40 100');
  });

  expect(ctx.port.sessionRequests).toMatchObject([{ kind: 'start', cols: 100, rows: 40 }]);
});

test('it applies a resize that arrived before impd answered the start', async () => {
  const ready = Promise.withResolvers<void>();

  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      ready: ready.promise,
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  ctx.port.startAnswerHold();
  ready.resolve();

  await waitFor(() => {
    expect(ctx.port.sessionRequests).toHaveLength(1);
  });

  harness.resize(100, 40);
  harness.write('size\n');
  ctx.port.stopAnswerHold();

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:40 100');
  });
});

test('it settles its start once impd starts the process', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [ctx.script],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  await harness.waitForStart();

  expect(exits).toStrictEqual([]);
});

test('it rejects its start as broker_not_ready and ends without running when impd finds the broker not ready', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({
    code: 'broker_not_ready',
    data: { imp: 'imp-b', detail: 'the imp holds no grant' },
  });

  expect(exits).toStrictEqual([
    { exitCode: 1, reason: 'ended', detail: 'imp broker not ready (the imp holds no grant)' },
  ]);
});

test('it requires the broker again on the attach that reconnects a harness whose start required it', async () => {
  using ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['imp-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'imp-b' });
  await ctx.port.createGrant('imp-b', 'glm');

  const attachments: HarnessAttachment[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await harness.waitForStart();

  ctx.port.stopConnection('imp-b', 's2', 1011);

  await waitFor(() => {
    expect(attachments).toStrictEqual(['attached', 'reattaching', 'attached']);
  });

  expect(ctx.port.sessionRequests.filter((request) => request.name === 'imp-b')).toMatchObject([
    { kind: 'start', require: ['broker'] },
    { kind: 'attach', require: ['broker'] },
  ]);
});

test('it refuses a start that requires the broker on an impd without exec requirements and sends no exec', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  ctx.port.features = { ...ctx.port.features, execRequire: false };

  const exits: HarnessExit[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    data: { imp: 'imp-b', execRequire: false },
  });

  expect<Record<string, unknown>>({
    requests: ctx.port.sessionRequests.filter((request) => request.name === 'imp-b'),
    exits,
  }).toStrictEqual({
    requests: [],
    exits: [{ exitCode: 1, reason: 'ended', detail: 'impd too old to require the broker' }],
  });
});

test('it rejects its start as auth_impd_too_old when impd refuses it as outdated', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  ctx.port.setNextSessionFailure('PRECONDITION_FAILED', { reason: 'impd_outdated' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  expect(harness.waitForStart()).rejects.toMatchObject({ code: 'auth_impd_too_old' });
});

test('it starts a harness that requires the broker after one failed feature read, sending the start again rather than an attach', async () => {
  using ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['imp-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'imp-b' });
  await ctx.port.createGrant('imp-b', 'glm');

  ctx.port.setFeatureFailures(1);

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  await harness.waitForStart();

  expect<Record<string, unknown>>({
    requests: ctx.port.sessionRequests
      .filter((request) => request.name === 'imp-b')
      .map((request) => request.kind),
    state: ctx.port.findState('imp-b'),
  }).toStrictEqual({ requests: ['start'], state: 'running' });
});

test('it refuses a harness that requires the broker once its feature reads keep failing, sending no exec', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  ctx.port.setFeatureFailures(10);

  const exits: HarnessExit[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({ code: 'host_unavailable' });

  expect<Record<string, unknown>>({
    requests: ctx.port.sessionRequests.filter((request) => request.name === 'imp-b'),
    exits,
  }).toStrictEqual({
    requests: [],
    exits: [{ exitCode: 1, reason: 'ended', detail: 'imp unreachable' }],
  });
});

test('it refuses a harness whose admission check throws as its connection opens, sending no exec', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      admit: (_kind, send) => {
        send({
          check: () => {
            throw new Error('the binder broke');
          },
          release: () => {},
        });

        return Promise.resolve();
      },
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({ code: 'internal' });
  expect(ctx.port.sessionRequests.filter((request) => request.name === 'imp-b')).toStrictEqual([]);
});

test('it sends the start of a harness whose admission check passes as its connection opens', async () => {
  using ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['imp-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'imp-b' });
  await ctx.port.createGrant('imp-b', 'glm');

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
      admit: (_kind, send) => {
        send({ check: () => null, release: () => {} });

        return Promise.resolve();
      },
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  expect(harness.waitForStart()).resolves.toBeUndefined();

  expect(ctx.port.sessionRequests.filter((request) => request.name === 'imp-b')).toMatchObject([
    { kind: 'start', name: 'imp-b' },
  ]);
});

test('it tells its host the harness is done only after every exit listener has run', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  const order: string[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sh', '-c', 'exit 3'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {
        order.push('done');
      },
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onExit(() => {
    order.push('exit');
  });

  await waitFor(() => {
    expect(order).toStrictEqual(['exit', 'done']);
  });
});

test('it tells its host the harness is done once when the daemon lets go of it, with no exit', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'imp-b' });

  const order: string[] = [];

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {
        order.push('done');
      },
    },
  );

  onTestFinished(() => {
    harness.kill();
  });

  harness.onExit(() => {
    order.push('exit');
  });

  await harness.waitForStart();

  harness.detach();
  harness.detach();

  expect(order).toStrictEqual(['done']);
});
