import { expect, mock, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildTarArchive } from '@atc/core/build-tar-archive';
import { createStubBin } from '@atc/test-utils/create-stub-bin';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startStubImpd } from '@atc/test-utils/start-stub-impd';
import { waitFor } from '@atc/test-utils/wait-for';
import invariant from 'tiny-invariant';
import CHECK_GUEST_ATC_SCRIPT from './check-guest-atc.sh' with { type: 'text' };
import { ImpClientPort } from './imp-client-port';
import { ImpProvider } from './imp-provider';
import INSTALL_GUEST_ATC_SCRIPT from './install-guest-atc.sh' with { type: 'text' };
import LINK_GUEST_ATC_SCRIPT from './link-guest-atc.sh' with { type: 'text' };
import READ_GUEST_ATC_SCRIPT from './read-guest-atc.sh' with { type: 'text' };
import READY_GUEST_DIR_SCRIPT from './ready-guest-dir.sh' with { type: 'text' };
import { buildMockImpIdentity } from './testing/build-mock-imp-identity';
import { createStubImpPort } from './testing/create-stub-imp-port';
import UNPACK_SCRIPT from './unpack-archive.sh' with { type: 'text' };

/**
 * A stub imp port and a temp directory.
 */
function setupTest() {
  const tmp = setupTempDir('atc-imp-provider-');
  const port = createStubImpPort();

  return { dir: tmp.dir, port };
}

test('it keeps an existing-host check refused when impd errors after the credential check', async () => {
  const impd = startStubImpd();

  impd.answers.set('/rpc/tokens/whoami', { status: 200, json: buildMockImpIdentity() });
  impd.answers.set('/rpc/imps/get', { status: 500, json: { message: 'impd unavailable' } });

  const provider = new ImpProvider(
    new ImpClientPort({ url: impd.url, readToken: () => 'current-token' }),
    {},
    { version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  const reachable = await provider.checkExistingHost('s1');

  expect(reachable).toBe(false);

  expect(impd.calls.map((call) => call.path)).toStrictEqual([
    '/rpc/tokens/whoami',
    '/rpc/imps/get',
  ]);

  expect(impd.authorizations).toStrictEqual(['Bearer current-token', 'Bearer current-token']);
});

test('it keeps an existing-host check refused when impd is unreachable', async () => {
  const impd = startStubImpd();

  const provider = new ImpProvider(
    new ImpClientPort({ url: impd.url, readToken: () => 'current-token' }),
    {},
    { version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await impd.stop();

  const reachable = await provider.checkExistingHost('s1');

  expect(reachable).toBe(false);
  expect(impd.calls).toStrictEqual([]);
});

test('it destroys the imp a failed prepare created, since no session holds it', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await Promise.allSettled([
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ]);

  expect(ctx.port.calls).toStrictEqual([
    'system.info',
    'imps.get atc-s1',
    'imps.create atc-s1',
    'leases.acquire atc-s1 atc-d1',
    `exec.run atc-s1 sh -c ${READ_GUEST_ATC_SCRIPT} sh ${join(ctx.dir, 'g')} ${join(ctx.dir, 'missing-atc')} 1.0.0`,
    'imps.destroy atc-s1',
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
});

test('it refuses a prepare that installs atc when the guest atc is missing and the daemon has no binary to copy', () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    message: `imp atc-s1 cannot run hooks through atc 1.0.0: the image has no executable atc at ${join(ctx.dir, 'missing-atc')}, and a daemon run from source has no binary to copy in; install atc 1.0.0 there, or run a compiled atc daemon on Linux`,
    data: { problem: 'no_guest_atc' },
  });
});

test("it refuses a prepare that installs atc when the image's atc runs another version and the daemon has no binary to copy", () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    message: `imp atc-s1 cannot run hooks through atc 1.0.0: the image's atc at ${guestATC} is 0.9.0, and a daemon run from source has no binary to copy in; install atc 1.0.0 there, or run a compiled atc daemon on Linux`,
    data: { problem: 'no_guest_atc' },
  });
});

test("it links the guest's atc to the image's atc and copies nothing when the image's atc runs the daemon's version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 1.0.0\n');
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(readlinkSync(join(ctx.dir, 'g', 'bin', 'atc'))).toBe(guestATC);
  expect(ctx.port.calls).toSatisfyAll((call: string) => !call.includes('tar -x'));

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the image's atc 1.0.0 at ${guestATC}`,
  );
});

test("it copies the daemon's atc in when the image's atc runs another version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(lstatSync(join(ctx.dir, 'g', 'bin', 'atc')).isSymbolicLink()).toBeFalse();
  expect(readFileSync(join(ctx.dir, 'g', 'bin', 'atc'), 'utf8')).toBe('#!/bin/sh\necho 1.0.0\n');

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, copied to ${join(ctx.dir, 'g')}/bin/atc: the image's atc at ${guestATC} is 0.9.0`,
  );
});

test("it copies the daemon's atc in when the image has no atc at the target's path", async () => {
  const ctx = setupTest();
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(readFileSync(join(ctx.dir, 'g', 'bin', 'atc'), 'utf8')).toBe('#!/bin/sh\necho 1.0.0\n');

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, copied to ${join(ctx.dir, 'g')}/bin/atc: the image has no executable atc at ${join(ctx.dir, 'missing-atc')}`,
  );
});

test("it replaces a link to the image's atc with the daemon's atc when the image's atc runs another version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  mkdirSync(join(ctx.dir, 'g', 'bin'), { recursive: true });
  symlinkSync(guestATC, join(ctx.dir, 'g', 'bin', 'atc'));

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(lstatSync(join(ctx.dir, 'g', 'bin', 'atc')).isSymbolicLink()).toBeFalse();
  expect(readFileSync(guestATC, 'utf8')).toBe('#!/bin/sh\necho 0.9.0\n');
});

test("it keeps a copy of the daemon's atc an imp already holds and copies nothing", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  createStubBin(join(ctx.dir, 'g', 'bin'), 'atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(ctx.port.calls).toSatisfyAll((call: string) => !call.includes('tar -x'));

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, already at ${join(ctx.dir, 'g')}/bin/atc: the image's atc at ${guestATC} is 0.9.0`,
  );
});

test("it links the guest's atc again on a later readying without reading the image's version again", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  rmSync(join(ctx.dir, 'g', 'bin'), { recursive: true });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(ctx.port.calls.filter((call) => call.includes('--version'))).toBeArrayOfSize(1);
  expect(readlinkSync(join(ctx.dir, 'g', 'bin', 'atc'))).toBe(guestATC);
});

test("it copies the daemon's atc again on a later readying of an imp that lost it, without reading the image's version again", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.dir, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  rmSync(join(ctx.dir, 'g', 'bin'), { recursive: true });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(ctx.port.calls.filter((call) => call.includes('--version'))).toBeArrayOfSize(1);
  expect(readFileSync(join(ctx.dir, 'g', 'bin', 'atc'), 'utf8')).toBe('#!/bin/sh\necho 1.0.0\n');
});

test("it reads the image's version again for an imp created after the one it read was destroyed", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });
  await provider.destroyHost('s1');
  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(ctx.port.calls.filter((call) => call.includes('--version'))).toBeArrayOfSize(2);
});

test('it refuses a retried prepare on an imp whose atc runs another version when the daemon has no binary to copy', async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.dir, 'image-atc', '#!/bin/sh\necho 0.9.0\n');

  createStubBin(join(ctx.dir, 'g', 'bin'), 'atc', '#!/bin/sh\necho 0.8.0\n');

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  await Promise.allSettled([
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ]);

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'no_guest_atc' },
  });
});

test("it uses an image's atc at the guest's own atc path when it runs the daemon's version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(join(ctx.dir, 'g', 'bin'), 'atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the image's atc 1.0.0 at ${guestATC}`,
  );
});

test('it keeps an imp that existed before a failed prepare and gives back only its own lease', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), guestATC: join(ctx.dir, 'missing-atc') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.acquireOtherLease('atc-s1', 'token:other', 'build', 60);

  const before = await ctx.port.readImp('atc-s1');

  const prepared = provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  await Promise.allSettled([prepared]);

  const imp = await ctx.port.readImp('atc-s1');

  expect(before).toMatchObject({ name: 'atc-s1', leases: [], otherLeaseCount: 1 });

  expect(prepared).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { problem: 'no_guest_atc' },
  });

  expect(imp).toMatchObject({ name: 'atc-s1', leases: [], otherLeaseCount: 1 });
});

test('it names each imp under the atc- prefix when the target sets none', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect(provider.impPrefix).toBe('atc-');
  expect(ctx.port.collectImpNames()).toStrictEqual(['atc-s1']);
});

test("it names each imp under the target's configured prefix", async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  expect(ctx.port.collectImpNames()).toStrictEqual(['harness-s1']);
});

test("it scopes its broker and its imp names to the target's configured prefix", () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  expect(provider.brokerAuth.hostPrefix).toBe('harness-');
  expect(provider.getImpName('s1')).toStartWith('harness-');
});

test('it reads the identity of the token its port holds through its broker', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), impPrefix: 'harness-' },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'harness-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  const identity = await provider.brokerAuth.readIdentity();

  expect(identity).toMatchObject({ name: 'harness-runtime', grantable: ['glm'] });
});

test('it asks impd to require the broker on a harness start that requires one', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await Promise.allSettled([harness.waitForStart()]);

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({ kind: 'start', name: 'atc-s1', require: ['broker'] }),
  ]);
});

test('it keeps a full UUID imp session name inside the session limit', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await Promise.allSettled([harness.waitForStart()]);

  const requests = ctx.port.sessionRequests.map((request) => `${request.kind} ${request.session}`);

  expect<readonly unknown[]>(requests).toStrictEqual([
    expect.stringMatching(/^start [a-z0-9][a-z0-9-]{0,31}$/),
  ]);
});

test('it derives one imp session name per session', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
    other.kill();
  });

  invariant(
    first.waitForStart !== undefined &&
      repeat.waitForStart !== undefined &&
      other.waitForStart !== undefined,
    'the imp harness reports no start',
  );

  await Promise.allSettled([first.waitForStart(), repeat.waitForStart(), other.waitForStart()]);

  const sessions = ctx.port.sessionRequests.map((request) => request.session);

  const distinct = new Set(sessions);

  expect<readonly unknown[]>(sessions).toStrictEqual([
    sessions[0],
    sessions[0],
    expect.any(String),
  ]);

  expect(distinct.size).toBe(2);
});

test('it asks impd to require nothing on a harness start that requires no broker', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
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

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await harness.waitForStart();

  const [request] = ctx.port.sessionRequests;

  invariant(request !== undefined, 'expected a session request');

  expect(request).not.toContainKey('require');
});

test("it creates a host's imp for the broker with the target's image and memory", async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g'), image: 'base', memoryMib: 512 },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  const created = await provider.brokerAuth.createHost('s1');

  expect(created).toStrictEqual({ id: expect.toBeString(), name: 'atc-s1' });
  expect(ctx.port.calls).toStrictEqual(['imps.create atc-s1']);
  expect(ctx.port.createSpecs).toStrictEqual([{ name: 'atc-s1', image: 'base', memoryMib: 512 }]);
});

test('it sends an archive to an imp gzipped and unpacks it there', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  // A gzip ahead of the guest's own on its PATH keeps a copy of what tar
  // hands it to unpack, which is what crossed the wire.
  const realGzip = Bun.which('gzip');

  invariant(realGzip !== null);

  const wire = join(ctx.dir, 'wire.bin');
  const bin = join(ctx.dir, 'bin');

  createStubBin(bin, 'gzip', `#!/bin/sh\ntee '${wire}' | '${realGzip}' "$@"\n`);

  ctx.port.setGuestPath(`${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);

  const archive = buildTarArchive([{ path: 'src/a.txt', content: 'hello from the daemon' }]);

  await provider.transferArchive(archive, join(ctx.dir, 'w'), 's1');

  expect(readFileSync(join(ctx.dir, 'w', 'src', 'a.txt'), 'utf8')).toBe('hello from the daemon');
  expect(gunzipSync(readFileSync(wire))).toStrictEqual(Buffer.from(archive));
});

test('it refuses a transfer to an imp without gzip and leaves the directory uncreated', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  // The guest's PATH holds every tool the unpack runs except gzip.
  const bin = join(ctx.dir, 'bin');

  mkdirSync(bin);

  for (const tool of ['sh', 'mkdir', 'tar']) {
    const path = Bun.which(tool);

    invariant(path !== null);
    symlinkSync(path, join(bin, tool));
  }

  ctx.port.setGuestPath(bin);

  const archive = buildTarArchive([{ path: 'a.txt', content: 'never unpacked' }]);

  expect(provider.transferArchive(archive, join(ctx.dir, 'w'), 's1')).rejects.toThrowWithMessage(
    Error,
    `imp atc-s1 has no gzip, which unpacking the archive into ${join(ctx.dir, 'w')} needs; install gzip in its image`,
  );

  expect(existsSync(join(ctx.dir, 'w'))).toBe(false);
});

test.each([
  ['unpacks an archive', UNPACK_SCRIPT],
  ['reads the guest atc versions', READ_GUEST_ATC_SCRIPT],
  ['links the guest atc', LINK_GUEST_ATC_SCRIPT],
  ['checks the guest atc', CHECK_GUEST_ATC_SCRIPT],
  ['readies the guest folder', READY_GUEST_DIR_SCRIPT],
  ['installs the guest atc', INSTALL_GUEST_ATC_SCRIPT],
])('it %s through a script that passes shellcheck', async (_label, script) => {
  const result = await runShellcheck(script);

  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});

test("it logs the end of a harness's hook forward and listens on the guest socket again", async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0', reconnectDelaysMs: [0] },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({
    host: 's1',
    daemonID: 'd1',
    log: (line) => {
      lines.push(line);
    },
  });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: () => {},
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await harness.waitForStart();

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'g', 'run', 's1.sock'))).toBeTrue();
  });

  expect(lines).toContain(
    "imp atc-s1 stopped listening for session s1's hooks (closed 1006); listening again in 0ms",
  );
});

test('it listens on the guest socket no more once the harness ended', async () => {
  const ctx = setupTest();

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0', reconnectDelaysMs: [0] },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: () => {},
  });

  const exited = Promise.withResolvers<void>();

  harness.onExit(() => {
    exited.resolve();
  });

  await exited.promise;

  const reverseCalls = ctx.port.calls.filter((call) => call.startsWith('reverse '));

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  expect(existsSync(join(ctx.dir, 'g', 'run', 's1.sock'))).toBeFalse();
  expect(reverseCalls).toStrictEqual([`reverse atc-s1 ${join(ctx.dir, 'g', 'run', 's1.sock')}`]);
});

test('it leaves a hook forward that impd lost with the guest ended, so the imp sleeps on', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0', reconnectDelaysMs: [0] },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({
    host: 's1',
    daemonID: 'd1',
    log: (line) => {
      lines.push(line);
    },
  });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: () => {},
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await harness.waitForStart();

  ctx.port.stopForwards({ kind: 'lost' });

  await waitFor(() => {
    expect(lines).toContain(
      "imp atc-s1 stopped listening for session s1's hooks (the imp went away); a wake listens again",
    );
  });

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toStrictEqual([
    `reverse atc-s1 ${join(ctx.dir, 'g', 'run', 's1.sock')}`,
  ]);
});

test('it leaves a hook forward ended when the imp starts to sleep during the wait to listen again', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = new ImpProvider(
    ctx.port,
    { guestDir: join(ctx.dir, 'g') },
    { atcBinary: null, version: '1.0.0', reconnectDelaysMs: [0] },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  const suspends: Promise<void>[] = [];

  await provider.prepareHost({
    host: 's1',
    daemonID: 'd1',
    log: (line) => {
      lines.push(line);

      if (line.endsWith('listening again in 0ms')) {
        suspends.push(provider.suspendHost('s1'));
      }
    },
  });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: () => {},
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await harness.waitForStart();

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  await waitFor(() => {
    expect(lines).toContain(
      "imp atc-s1 went to sleep before session s1's hooks listened again; a wake listens again",
    );
  });

  await Promise.all(suspends);

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toStrictEqual([
    `reverse atc-s1 ${join(ctx.dir, 'g', 'run', 's1.sock')}`,
  ]);
});
