import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import { verifyBrokerAuthority } from './verify-broker-authority';

/**
 * A stub imp port and a temp directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-imp-provider-'));
  const port = stack.use(buildStubImpPort());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    port,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it destroys the imp a failed prepare created, since no session holds it', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  await Promise.allSettled([
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ]);

  expect(ctx.port.collectImpNames()).toBeEmpty();
});

test('it refuses a prepare that installs atc when the guest atc is missing', () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'no_guest_atc' },
  });
});

test('it keeps an imp that existed before a failed prepare and gives back only its own lease', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.acquireOtherLease('atc-s1', 'token:other', 'build', 60);

  await Promise.allSettled([
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ]);

  const imp = await ctx.port.readImp('atc-s1');

  expect(imp).toMatchObject({ name: 'atc-s1', leases: [], otherLeaseCount: 1 });
});

test('it names each imp under the atc- prefix when the target sets none', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(ctx.port, { guestDir: join(ctx.dir, 'g') }, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect({ prefix: provider.impPrefix, imps: ctx.port.collectImpNames() }).toStrictEqual({
    prefix: 'atc-',
    imps: ['atc-s1'],
  });
});

test("it names each imp under the target's configured prefix", async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect(ctx.port.collectImpNames()).toStrictEqual(['harness-s1']);
});

test("it lets a token scoped to the target's configured prefix activate the broker for its imps", async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'harness-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  const verified = verifyBrokerAuthority(
    ctx.port,
    { impNames: [provider.getImpName('s1')], secrets: ['glm'] },
    provider.impPrefix,
  );

  await expect(verified).toResolve();
});

test("it refuses a token scoped beyond the target's configured prefix", () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const verified = verifyBrokerAuthority(
    ctx.port,
    { impNames: [provider.getImpName('s1')], secrets: ['glm'] },
    provider.impPrefix,
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_token_too_broad' });
});

test('it asks impd to require the broker on a harness start that requires one', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(ctx.port, { guestDir: join(ctx.dir, 'g') }, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
    requireBroker: true,
  });

  onTestFinished(() => {
    harness.kill();
  });

  if (harness.waitForStart === undefined) {
    throw new Error('the imp harness reports no start');
  }

  await Promise.allSettled([harness.waitForStart()]);

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({ kind: 'start', name: 'atc-s1', require: ['broker'] }),
  ]);
});

test('it keeps a full UUID imp session name inside the session limit', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(ctx.port, { guestDir: join(ctx.dir, 'g') }, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  const harness = provider.spawnHarness({
    session: '9d53f7d6-f7b4-4809-9bf6-17d3b5b0c058',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness.kill();
  });

  if (harness.waitForStart === undefined) {
    throw new Error('the imp harness reports no start');
  }

  await Promise.allSettled([harness.waitForStart()]);

  const requests = ctx.port.sessionRequests.map((request) => `${request.kind} ${request.session}`);

  expect<readonly unknown[]>(requests).toStrictEqual([
    expect.stringMatching(/^start [a-z0-9][a-z0-9-]{0,31}$/),
  ]);
});

test('it derives one imp session name per session', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(ctx.port, { guestDir: join(ctx.dir, 'g') }, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createImp({ name: 'atc-s2' });
  await ctx.port.createImp({ name: 'atc-s3' });

  const first = provider.spawnHarness({
    session: '9d53f7d6-f7b4-4809-9bf6-17d3b5b0c058',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    first.kill();
  });

  const repeat = provider.spawnHarness({
    session: '9d53f7d6-f7b4-4809-9bf6-17d3b5b0c058',
    host: 's2',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    repeat.kill();
  });

  const other = provider.spawnHarness({
    session: 'ad53f7d6-f7b4-4809-9bf6-17d3b5b0c058',
    host: 's3',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    other.kill();
  });

  if (
    first.waitForStart === undefined ||
    repeat.waitForStart === undefined ||
    other.waitForStart === undefined
  ) {
    throw new Error('the imp harness reports no start');
  }

  await Promise.allSettled([first.waitForStart(), repeat.waitForStart(), other.waitForStart()]);

  const sessions = ctx.port.sessionRequests.map((request) => request.session);

  const distinct = new Set(sessions);

  expect<Record<string, unknown>>({ sessions, distinct: distinct.size }).toStrictEqual({
    sessions: [sessions[0], sessions[0], expect.any(String)],
    distinct: 2,
  });
});

test('it asks impd to require nothing on a harness start that requires no broker', async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(ctx.port, { guestDir: join(ctx.dir, 'g') }, { atcBinary: null });

  onTestFinished(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness.kill();
  });

  if (harness.waitForStart === undefined) {
    throw new Error('the imp harness reports no start');
  }

  await harness.waitForStart();

  const [request] = ctx.port.sessionRequests;

  if (request === undefined) {
    throw new Error('expected a session request');
  }

  expect(request).not.toContainKey('require');
});

test("it creates a host's imp for the broker with the target's image and memory", async () => {
  using ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), image: 'base', memoryMib: 512 },
    { atcBinary: null },
  );

  onTestFinished(() => {
    provider.dispose();
  });

  const created = await provider.brokerAuth.createImp('s1');

  expect<Record<string, unknown>>({ created, calls: ctx.port.calls }).toStrictEqual({
    created: expect.objectContaining({ name: 'atc-s1', state: 'running' }),
    calls: ['imps.create atc-s1'],
  });
});
