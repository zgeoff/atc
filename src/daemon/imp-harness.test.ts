import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import type { HarnessAttachment, HarnessExit } from './execution-provider';
import { ImpHarness } from './imp-harness';

// The bytes a fresh attach clears the screen with before its replay.
const SCREEN_RESET = '\u001B[0m\u001B[H\u001B[2J';

// A harness on imp `imp-a` over a fixture imp port, running a script that
// prints its pid, echoes each line it reads, and on `later` prints 300000
// bytes after a short wait, more than impd's ring keeps.
async function setupTest(
  options: Readonly<{ offsets?: boolean; continuity?: 'offsets' | 'none' }> = {},
) {
  const tmp = setupTempDir('atc-imp-harness-');
  const script = join(tmp.dir, 'harness');

  const port = new FixtureImpPort();

  writeFileSync(
    script,
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  if [ "$line" = "later" ]; then
    (sleep 0.3; head -c 300000 /dev/zero | tr '\\0' 'x'; echo; echo "BURST_DONE") &
  fi
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line"
done
`,
    { mode: 0o755 },
  );

  port.continuity = options.continuity ?? 'offsets';

  await port.createImp({ name: 'imp-a' });

  const harness = new ImpHarness(
    port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [script],
      env: {},
      cwd: tmp.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: options.offsets ?? true,
      reconnectDelaysMs: [0, 0, 0],
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  const output: string[] = [];
  const exits: HarnessExit[] = [];
  const attachments: HarnessAttachment[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  harness.onExit((exit) => {
    exits.push(exit);
  });

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('UP:');
  });

  return {
    port,
    harness,
    exits,
    attachments,
    readOutput: () => output.join(''),
    [Symbol.dispose]() {
      harness.detach();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it reconnects after impd drops a send and resumes after the last byte it has', async () => {
  using fixture = await setupTest();

  fixture.harness.write('one\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:one');
  });

  const end = fixture.port.getEnd('imp-a', 's1');

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  fixture.harness.write('two\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:two');
  });

  expect(fixture.port.sessionRequests[1]).toMatchObject({
    kind: 'attach',
    wake: false,
    resumeFrom: { executionGeneration: fixture.port.getGeneration('imp-a', 's1'), offset: end },
  });

  expect(fixture.attachments).toStrictEqual(['attached', 'reattaching', 'attached']);
  expect(fixture.exits).toBeEmpty();
});

test('it drops the bytes a resume repeats below its high-water offset', async () => {
  using fixture = await setupTest();

  fixture.port.resumeOverlap = 4096;

  fixture.harness.write('one\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:one');
  });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  fixture.harness.write('two\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:two');
  });

  expect(fixture.readOutput().split('GOT:one')).toHaveLength(2);
  expect(fixture.readOutput().split('UP:')).toHaveLength(2);
});

test('it does a fresh attach that clears the screen when the resume finds a gap', async () => {
  using fixture = await setupTest();

  fixture.harness.write('later\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:later');
  });

  const end = fixture.port.getEnd('imp-a', 's1');

  fixture.port.startAnswerHold();
  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.port.getEnd('imp-a', 's1') - end).toBeGreaterThan(300_000);
  });

  fixture.port.stopAnswerHold();

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('BURST_DONE');
  });

  expect(
    fixture.port.sessionRequests.map((request) => [request.kind, 'resumeFrom' in request]),
  ).toStrictEqual([
    ['start', false],
    ['attach', true],
    ['attach', false],
  ]);

  expect(fixture.readOutput()).toInclude(SCREEN_RESET);
  expect(fixture.exits).toBeEmpty();
});

test('it does a fresh attach when impd refuses its resume offset', async () => {
  using fixture = await setupTest();

  fixture.port.setNextSessionFailure('INVALID_RESUME', { end: 0, bufferStart: 0 });
  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.attachments.slice(1)).toStrictEqual(['reattaching', 'reattaching', 'attached']);
  });

  fixture.harness.write('three\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:three');
  });

  expect(
    fixture.port.sessionRequests.map((request) => [request.kind, 'resumeFrom' in request]),
  ).toStrictEqual([
    ['start', false],
    ['attach', true],
    ['attach', false],
  ]);

  expect(fixture.readOutput()).toInclude(SCREEN_RESET);
});

test('it reattaches after another connection takes the session over', async () => {
  using fixture = await setupTest();

  const other = fixture.port.openSession(
    { kind: 'attach', name: 'imp-a', session: 's1', cols: 80, rows: 24, wake: true },
    { onStarted: () => {}, onOutput: () => {} },
  );

  expect(other.outcome).resolves.toMatchObject({ kind: 'detached', reason: 'taken_over' });

  await other.outcome;

  fixture.harness.write('four\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:four');
  });

  expect(fixture.port.sessionRequests[2]).toMatchObject({ kind: 'attach', wake: false });
});

test('it ends a harness whose imp booted cold with the cause of the first boot after its own', async () => {
  using fixture = await setupTest();

  fixture.port.bootImpCold('imp-a', 'watchdog');

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'imp rebooted (watchdog)' },
    ]);
  });
});

test('it ends a harness without a boot id as ended with the cause unknown', async () => {
  using fixture = await setupTest({ continuity: 'none' });

  fixture.port.bootImpCold('imp-a', 'watchdog');

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' },
    ]);
  });
});

test('it ends with the kept exit code of its own generation when impd no longer holds it', async () => {
  using fixture = await setupTest();

  fixture.port.setNextSessionFailure('NO_SESSION', {
    bootId: fixture.port.getBootID('imp-a'),
    coldBoots: [],
    previous: {
      executionGeneration: fixture.port.getGeneration('imp-a', 's1'),
      end: 10,
      exitCode: 7,
    },
  });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([{ exitCode: 7, reason: 'exited' }]);
  });
});

test('it never sends a resume offset to a session whose agent carries none', async () => {
  using fixture = await setupTest({ continuity: 'none' });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  fixture.harness.write('five\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:five');
  });

  expect(fixture.port.sessionRequests.some((request) => 'resumeFrom' in request)).toBeFalse();
  expect(fixture.readOutput()).toInclude(SCREEN_RESET);
});

test('it never sends a resume offset when impd carries no offsets', async () => {
  using fixture = await setupTest({ offsets: false });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.attachments.slice(1)).toStrictEqual(['reattaching', 'attached']);
  });

  fixture.harness.write('six\r');

  await waitFor(() => {
    expect(fixture.readOutput()).toInclude('GOT:six');
  });

  expect(fixture.port.sessionRequests.some((request) => 'resumeFrom' in request)).toBeFalse();
});

test('it reports a harness whose imp another owner put to sleep as suspended, without waking it', async () => {
  using fixture = await setupTest();

  fixture.port.suspendWithForce('imp-a');

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([{ exitCode: 0, reason: 'suspended' }]);
  });

  expect(fixture.port.sessionRequests[1]).toMatchObject({ kind: 'attach', wake: false });
  expect(fixture.port.findState('imp-a')).toBe('sleeping');
});

test('it confirms the exit of a killed harness once impd reports its process exited', async () => {
  using fixture = await setupTest();

  fixture.harness.kill();

  const exited = await fixture.harness.waitForExit(5000);

  expect(exited).toBeTrue();
});

test('it reports no exit for a running harness whose wait runs out', async () => {
  using fixture = await setupTest();

  const exited = await fixture.harness.waitForExit(50);

  expect(exited).toBeFalse();
});

test('it reports no exit for a harness whose imp went to sleep with the process inside', async () => {
  using fixture = await setupTest();

  const waited = fixture.harness.waitForExit(5000);

  fixture.port.suspendWithForce('imp-a');

  const exited = await waited;

  expect(exited).toBeFalse();
});

test('it counts connections impd drops before they start, and ends once its reconnects run out', async () => {
  using fixture = await setupTest();

  fixture.port.setSessionDrops(10, 1011);
  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'imp connection closed (code 1011)' },
    ]);
  });

  expect(fixture.port.sessionRequests).toHaveLength(5);
});

test('it ends once its reconnects run out when a listener throws on every connection that starts', async () => {
  using fixture = await setupTest();

  fixture.harness.onAttachment((attachment) => {
    if (attachment === 'attached') {
      throw new Error('write EPIPE');
    }
  });

  fixture.port.stopConnection('imp-a', 's1', 1011);

  await waitFor(() => {
    expect(fixture.exits).toStrictEqual([
      {
        exitCode: 1,
        reason: 'ended',
        detail: 'imp connection failed in the daemon (write EPIPE)',
      },
    ]);
  });

  expect(fixture.port.sessionRequests).toHaveLength(5);
});

test('it starts at the size a resize asked for while its host was still readying', async () => {
  using tmp = setupTempDir('atc-imp-harness-');

  using port = new FixtureImpPort();

  const script = join(tmp.dir, 'size');

  writeFileSync(script, '#!/usr/bin/env bash\necho "SIZE:$(stty size)"\nsleep 30\n', {
    mode: 0o755,
  });

  await port.createImp({ name: 'imp-a' });

  const ready = Promise.withResolvers<void>();
  const output: string[] = [];

  const harness = new ImpHarness(
    port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [script],
      env: {},
      cwd: tmp.dir,
      cols: 80,
      rows: 24,
    },
    {
      offsets: true,
      reconnectDelaysMs: [0, 0, 0],
      ready: ready.promise,
      isSuspending: () => false,
      onDone: () => {},
    },
  );

  harness.onData((data) => {
    output.push(data);
  });

  harness.resize(100, 40);
  ready.resolve();

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:40 100');
  });

  expect(port.sessionRequests).toMatchObject([{ kind: 'start', cols: 100, rows: 40 }]);

  harness.kill();
});

test('it applies a resize that arrived before impd answered the start', async () => {
  using tmp = setupTempDir('atc-imp-harness-');

  using port = new FixtureImpPort();

  const script = join(tmp.dir, 'size');

  writeFileSync(
    script,
    '#!/usr/bin/env bash\nwhile read -r line; do echo "SIZE:$(stty size)"; done\n',
    { mode: 0o755 },
  );

  await port.createImp({ name: 'imp-a' });

  port.startAnswerHold();

  const output: string[] = [];

  const harness = new ImpHarness(
    port,
    {
      kind: 'start',
      name: 'imp-a',
      session: 's1',
      argv: [script],
      env: {},
      cwd: tmp.dir,
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

  harness.onData((data) => {
    output.push(data);
  });

  harness.resize(100, 40);
  harness.write('size\n');

  await waitFor(() => {
    expect(port.sessionRequests).toHaveLength(1);
  });

  port.stopAnswerHold();

  await waitFor(() => {
    expect(output.join('')).toInclude('SIZE:40 100');
  });

  harness.kill();
});

test('it settles its start once impd starts the process', async () => {
  using fixture = await setupTest();

  await fixture.harness.waitForStart();

  expect(fixture.exits).toStrictEqual([]);
});

test('it rejects its start as broker_not_ready and ends without running when impd finds the broker not ready', async () => {
  using fixture = await setupTest();

  await fixture.port.createImp({ name: 'imp-b' });

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  const exits: HarnessExit[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({
    code: 'broker_not_ready',
    data: { imp: 'imp-b', detail: 'the imp holds no grant' },
  });

  await started.catch(() => null);

  expect(exits).toStrictEqual([
    { exitCode: 1, reason: 'ended', detail: 'imp broker not ready (the imp holds no grant)' },
  ]);
});

test('it requires the broker again on the attach that reconnects a harness whose start required it', async () => {
  using fixture = await setupTest();

  fixture.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['imp-*'],
    grantable: ['glm'],
  });

  fixture.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await fixture.port.createImp({ name: 'imp-b' });
  await fixture.port.createGrant('imp-b', 'glm');

  const attachments: HarnessAttachment[] = [];

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  harness.onAttachment((attachment) => {
    attachments.push(attachment);
  });

  await harness.waitForStart();

  fixture.port.stopConnection('imp-b', 's2', 1011);

  await waitFor(() => {
    expect(attachments).toStrictEqual(['attached', 'reattaching', 'attached']);
  });

  expect(fixture.port.sessionRequests.filter((request) => request.name === 'imp-b')).toMatchObject([
    { kind: 'start', require: ['broker'] },
    { kind: 'attach', require: ['broker'] },
  ]);

  harness.kill();
});

test('it refuses a start that requires the broker on an impd without exec requirements and sends no exec', async () => {
  using fixture = await setupTest();

  await fixture.port.createImp({ name: 'imp-b' });

  fixture.port.features = { ...fixture.port.features, execRequire: false };

  const exits: HarnessExit[] = [];

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    data: { imp: 'imp-b', execRequire: false },
  });

  await started.catch(() => null);

  expect<Record<string, unknown>>({
    requests: fixture.port.sessionRequests.filter((request) => request.name === 'imp-b'),
    exits,
  }).toStrictEqual({
    requests: [],
    exits: [{ exitCode: 1, reason: 'ended', detail: 'impd too old to require the broker' }],
  });
});

test('it rejects its start as auth_impd_too_old when impd refuses it as outdated', async () => {
  using fixture = await setupTest();

  await fixture.port.createImp({ name: 'imp-b' });

  fixture.port.setNextSessionFailure('PRECONDITION_FAILED', { reason: 'impd_outdated' });

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  expect(harness.waitForStart()).rejects.toMatchObject({ code: 'auth_impd_too_old' });

  await harness.waitForStart().catch(() => null);
});

test('it starts a harness that requires the broker after one failed feature read, sending the start again rather than an attach', async () => {
  using fixture = await setupTest();

  fixture.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['imp-*'],
    grantable: ['glm'],
  });

  fixture.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await fixture.port.createImp({ name: 'imp-b' });
  await fixture.port.createGrant('imp-b', 'glm');

  fixture.port.setFeatureFailures(1);

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  await harness.waitForStart();

  expect<Record<string, unknown>>({
    requests: fixture.port.sessionRequests
      .filter((request) => request.name === 'imp-b')
      .map((request) => request.kind),
    state: fixture.port.findState('imp-b'),
  }).toStrictEqual({ requests: ['start'], state: 'running' });

  harness.kill();
});

test('it refuses a harness that requires the broker once its feature reads keep failing, sending no exec', async () => {
  using fixture = await setupTest();

  await fixture.port.createImp({ name: 'imp-b' });

  fixture.port.setFeatureFailures(10);

  const exits: HarnessExit[] = [];

  const harness = new ImpHarness(
    fixture.port,
    {
      kind: 'start',
      name: 'imp-b',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: '/tmp',
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

  harness.onExit((exit) => {
    exits.push(exit);
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({ code: 'host_unavailable' });

  await started.catch(() => null);

  expect<Record<string, unknown>>({
    requests: fixture.port.sessionRequests.filter((request) => request.name === 'imp-b'),
    exits,
  }).toStrictEqual({
    requests: [],
    exits: [{ exitCode: 1, reason: 'ended', detail: 'imp unreachable' }],
  });
});
