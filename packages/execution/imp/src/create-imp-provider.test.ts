import { expect, mock, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildTarArchive } from '@atc/core';
import {
  createStubBin,
  registerTestCleanup,
  setupTempDir,
  startStubImpd,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { createImpClientPort } from './create-imp-client-port';
import { createImpProvider } from './create-imp-provider';
import READ_GUEST_ATC_SCRIPT from './read-guest-atc.sh' with { type: 'text' };
import READY_GUEST_DIR_SCRIPT from './ready-guest-dir.sh' with { type: 'text' };
import { buildMockImpIdentity } from './testing/build-mock-imp-identity';
import { createStubImpPort } from './testing/create-stub-imp-port';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-imp-provider-');
  const port = createStubImpPort();

  return { directory: temporaryDirectory.path, port };
}

test('it keeps an existing-host check refused when impd errors after the credential check', async () => {
  const impd = startStubImpd();

  impd.answers.set('/rpc/tokens/whoami', { status: 200, json: buildMockImpIdentity() });
  impd.answers.set('/rpc/imps/get', { status: 500, json: { message: 'impd unavailable' } });

  const provider = createImpProvider(
    createImpClientPort({ url: impd.url, readToken: () => 'current-token' }),
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

  const provider = createImpProvider(
    createImpClientPort({ url: impd.url, readToken: () => 'current-token' }),
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

test("it refuses an existing-host check whose imp lies outside the token's imp patterns", async () => {
  const ctx = setupTest();
  const provider = createImpProvider(ctx.port, {}, { version: '1.0.0' });

  registerTestCleanup(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: provider.getImpName('s1') });

  ctx.port.setIdentity(buildMockImpIdentity({ imps: ['other-*'] }));

  const reachable = await provider.checkExistingHost('s1');

  expect(reachable).toBe(false);

  expect(ctx.port.calls).toStrictEqual([
    `imps.create ${provider.getImpName('s1')}`,
    'tokens.whoami',
  ]);
});

test('it destroys the imp a failed prepare created, since no session holds it', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
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
    `exec.run atc-s1 sh -c ${READ_GUEST_ATC_SCRIPT} sh ${join(ctx.directory, 'g')} ${join(ctx.directory, 'missing-atc')} 1.0.0  `,
    'imps.destroy atc-s1',
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
});

test('it refuses a prepare that installs atc when the guest atc is missing and the daemon has no binary to copy', () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'unsupported_operation',
    message: `imp atc-s1 cannot run hooks through atc 1.0.0: the image has no executable atc at ${join(ctx.directory, 'missing-atc')}, and a daemon run from source has no binary to copy in; install atc 1.0.0 there, or run a compiled atc daemon on Linux`,
    data: { problem: 'no_guest_atc' },
  });
});

test("it refuses a prepare that installs atc when the image's atc runs another version and the daemon has no binary to copy", () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
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
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 1.0.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(readlinkSync(join(ctx.directory, 'g', 'bin', 'atc'))).toBe(guestATC);
  expect(ctx.port.calls).toSatisfyAll((call: string) => !call.includes('tar -x'));

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the image's atc 1.0.0 at ${guestATC}`,
  );
});

test("it copies the daemon's atc in when the image's atc runs another version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(lstatSync(join(ctx.directory, 'g', 'bin', 'atc')).isSymbolicLink()).toBeFalse();

  expect(readFileSync(join(ctx.directory, 'g', 'bin', 'atc'), 'utf8')).toBe(
    '#!/bin/sh\necho 1.0.0\n',
  );

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, copied to ${join(ctx.directory, 'g')}/bin/atc: the image's atc at ${guestATC} is 0.9.0`,
  );
});

test.each([
  ['before the new atc has a byte on disk', 0],
  ['with the new atc half written', 20_480],
])(
  "it keeps the guest's old atc runnable while the copy that replaces it is paused %s",
  async (_label, bytes) => {
    const ctx = setupTest();
    const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');

    // tar writes 10 KiB records, so a pause after two leaves the new atc half
    // written; the comment pads the binary past the bytes the pause lets through.
    const atcBinary = createStubBin(
      ctx.directory,
      'daemon-atc',
      `#!/bin/sh\n# ${'x'.repeat(30_000)}\necho 1.0.0\n`,
    );

    createStubBin(join(ctx.directory, 'g', 'bin'), 'atc', '#!/bin/sh\necho 0.9.0\n');

    const provider = createImpProvider(
      ctx.port,
      { guestDir: join(ctx.directory, 'g'), guestATC },
      { atcBinary, version: '1.0.0' },
    );

    registerTestCleanup(() => {
      provider.dispose();
    });

    // A gzip ahead of the guest's own on its PATH hands tar the first bytes
    // of the unpacked archive, marks the pause, and holds the rest back
    // until the test lets it go, as a slow link to impd does.
    const realGzip = Bun.which('gzip');

    invariant(realGzip !== null);

    const bin = join(ctx.directory, 'bin');
    const paused = join(ctx.directory, 'paused');
    const resume = join(ctx.directory, 'resume');

    createStubBin(
      bin,
      'gzip',
      `#!/bin/sh\n'${realGzip}' "$@" | { dd bs=1 count=${bytes} 2> /dev/null; touch '${paused}'; until [ -e '${resume}' ]; do sleep 0.01; done; cat; }\n`,
    );

    registerTestCleanup(() => {
      writeFileSync(resume, '');
    });

    ctx.port.setGuestPath(`${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);

    const prepared = provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

    await waitFor(() => {
      expect(existsSync(paused)).toBeTrue();
    });

    const during = Bun.spawn(['sh', '-c', 'exec "$0"', join(ctx.directory, 'g', 'bin', 'atc')], {
      stdout: 'pipe',
    });

    const exitCode = await during.exited;

    const stdout = await new Response(during.stdout).text();

    await Bun.write(resume, '');

    await prepared;

    expect(exitCode).toBe(0);
    expect(stdout).toBe('0.9.0\n');

    expect(readFileSync(join(ctx.directory, 'g', 'bin', 'atc'), 'utf8')).toBe(
      `#!/bin/sh\n# ${'x'.repeat(30_000)}\necho 1.0.0\n`,
    );
  },
);

test("it leaves no staging folder in the guest folder after it copies the daemon's atc in", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(readdirSync(join(ctx.directory, 'g')).toSorted()).toStrictEqual(['bin', 'run']);
});

test("it copies the daemon's atc in when the image has no atc at the target's path", async () => {
  const ctx = setupTest();
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(readFileSync(join(ctx.directory, 'g', 'bin', 'atc'), 'utf8')).toBe(
    '#!/bin/sh\necho 1.0.0\n',
  );

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, copied to ${join(ctx.directory, 'g')}/bin/atc: the image has no executable atc at ${join(ctx.directory, 'missing-atc')}`,
  );
});

test("it sends the daemon's atc to an imp gzipped", async () => {
  const ctx = setupTest();
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  // A gzip ahead of the guest's own on its PATH keeps a copy of what tar
  // hands it to unpack, which is what crossed the wire.
  const realGzip = Bun.which('gzip');

  invariant(realGzip !== null);

  const wire = join(ctx.directory, 'wire.bin');
  const bin = join(ctx.directory, 'bin');

  createStubBin(bin, 'gzip', `#!/bin/sh\ntee '${wire}' | '${realGzip}' "$@"\n`);

  ctx.port.setGuestPath(`${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(readFileSync(join(ctx.directory, 'g', 'bin', 'atc'), 'utf8')).toBe(
    '#!/bin/sh\necho 1.0.0\n',
  );

  const sent = buildTarArchive([
    { path: 'bin/atc', content: '#!/bin/sh\necho 1.0.0\n', mode: 0o755 },
  ]);

  expect(gunzipSync(readFileSync(wire))).toStrictEqual(Buffer.from(sent));
});

test("it copies the daemon's atc it compressed for an earlier readying into a later one", async () => {
  const ctx = setupTest();
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const first = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g1'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    first.dispose();
  });

  const second = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g2'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    second.dispose();
  });

  await first.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  // A binary that changed on disk would reach the second imp only if the
  // second readying read and compressed it again.
  await Bun.write(atcBinary, '#!/bin/sh\necho 2.0.0\n');
  await second.prepareHost({ host: 's2', daemonID: 'd1', installATC: true });

  expect(readFileSync(join(ctx.directory, 'g2', 'bin', 'atc'), 'utf8')).toBe(
    '#!/bin/sh\necho 1.0.0\n',
  );
});

test("it refuses to copy the daemon's atc into an imp without gzip and leaves bin/atc unwritten", () => {
  const ctx = setupTest();
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  // The guest's PATH holds every tool the readying runs except gzip.
  const bin = join(ctx.directory, 'bin');

  mkdirSync(bin);

  for (const tool of ['sh', 'mkdir', 'rm', 'tar']) {
    const path = Bun.which(tool);

    invariant(path !== null);
    symlinkSync(path, join(bin, tool));
  }

  ctx.port.setGuestPath(bin);

  expect(
    provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({
    code: 'host_unavailable',
    message: `imp atc-s1 cannot be used: imp atc-s1 has no gzip, which installing atc in ${join(ctx.directory, 'g')} needs; install gzip in its image`,
    data: { provider: 'imp', problem: 'unknown' },
  });

  expect(existsSync(join(ctx.directory, 'g', 'bin', 'atc'))).toBe(false);
});

test("it replaces a link to the image's atc with the daemon's atc when the image's atc runs another version", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  mkdirSync(join(ctx.directory, 'g', 'bin'), { recursive: true });
  symlinkSync(guestATC, join(ctx.directory, 'g', 'bin', 'atc'));

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(lstatSync(join(ctx.directory, 'g', 'bin', 'atc')).isSymbolicLink()).toBeFalse();
  expect(readFileSync(guestATC, 'utf8')).toBe('#!/bin/sh\necho 0.9.0\n');
});

test("it keeps a copy of the daemon's atc an imp already holds and copies nothing", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  createStubBin(join(ctx.directory, 'g', 'bin'), 'atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true, log });

  expect(ctx.port.calls).toSatisfyAll((call: string) => !call.includes('tar -x'));

  expect(log).toHaveBeenCalledExactlyOnceWith(
    `imp atc-s1 runs hooks through the daemon's atc 1.0.0, already at ${join(ctx.directory, 'g')}/bin/atc: the image's atc at ${guestATC} is 0.9.0`,
  );
});

test("it links the guest's atc again on a later readying without reading the image's version again", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  rmSync(join(ctx.directory, 'g', 'bin'), { recursive: true });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(ctx.port.calls.filter((call) => call.includes('--version'))).toBeArrayOfSize(1);
  expect(readlinkSync(join(ctx.directory, 'g', 'bin', 'atc'))).toBe(guestATC);
});

test("it copies the daemon's atc again on a later readying of an imp that lost it, without reading the image's version again", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');
  const atcBinary = createStubBin(ctx.directory, 'daemon-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  rmSync(join(ctx.directory, 'g', 'bin'), { recursive: true });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });

  expect(ctx.port.calls.filter((call) => call.includes('--version'))).toBeArrayOfSize(1);

  expect(readFileSync(join(ctx.directory, 'g', 'bin', 'atc'), 'utf8')).toBe(
    '#!/bin/sh\necho 1.0.0\n',
  );
});

test("it links a new imp to the image's atc without running it when the image's atc is the one it ran before", async () => {
  const ctx = setupTest();
  const runs = join(ctx.directory, 'runs');

  const guestATC = createStubBin(
    ctx.directory,
    'image-atc',
    `#!/bin/sh\necho run >> ${runs}\necho 1.0.0\n`,
  );

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });
  await provider.destroyHost('s1');

  rmSync(join(ctx.directory, 'g'), { recursive: true });

  await provider.prepareHost({ host: 's2', daemonID: 'd1', installATC: true });

  expect(readFileSync(runs, 'utf8')).toBe('run\n');
  expect(ctx.port.calls.filter((call) => call.startsWith('exec.run atc-s2'))).toBeArrayOfSize(1);
  expect(readlinkSync(join(ctx.directory, 'g', 'bin', 'atc'))).toBe(guestATC);
});

test("it runs the image's atc again for a new imp when the image's atc was rewritten to the same size within the same second", async () => {
  const ctx = setupTest();
  const runs = join(ctx.directory, 'runs');

  const guestATC = createStubBin(
    ctx.directory,
    'image-atc',
    `#!/bin/sh\necho run >> ${runs}\necho 1.0.0\n`,
  );

  utimesSync(guestATC, 1_700_000_000.1, 1_700_000_000.1);

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });
  await provider.destroyHost('s1');

  rmSync(join(ctx.directory, 'g'), { recursive: true });
  writeFileSync(guestATC, `#!/bin/sh\necho new >> ${runs}\necho 1.0.0\n`);
  utimesSync(guestATC, 1_700_000_000.2, 1_700_000_000.2);

  await provider.prepareHost({ host: 's2', daemonID: 'd1', installATC: true });

  expect(readFileSync(runs, 'utf8')).toBe('run\nnew\n');
});

test("it refuses a new imp whose image's atc lost its execute bit since it ran, when the daemon has no binary to copy", async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });
  await provider.destroyHost('s1');

  rmSync(join(ctx.directory, 'g'), { recursive: true });
  chmodSync(guestATC, 0o644);

  expect(
    provider.prepareHost({ host: 's2', daemonID: 'd1', installATC: true }),
  ).rejects.toMatchObject({ code: 'unsupported_operation', data: { problem: 'no_guest_atc' } });
});

test("it runs the image's atc again for a new imp when the image's atc changed since it ran", async () => {
  const ctx = setupTest();
  const runs = join(ctx.directory, 'runs');

  const guestATC = createStubBin(
    ctx.directory,
    'image-atc',
    `#!/bin/sh\necho run >> ${runs}\necho 1.0.0\n`,
  );

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1', installATC: true });
  await provider.destroyHost('s1');

  rmSync(join(ctx.directory, 'g'), { recursive: true });
  createStubBin(ctx.directory, 'image-atc', `#!/bin/sh\necho changed >> ${runs}\necho 1.0.0\n`);

  await provider.prepareHost({ host: 's2', daemonID: 'd1', installATC: true });

  expect(readFileSync(runs, 'utf8')).toBe('run\nchanged\n');
});

test('it refuses a retried prepare on an imp whose atc runs another version when the daemon has no binary to copy', async () => {
  const ctx = setupTest();
  const guestATC = createStubBin(ctx.directory, 'image-atc', '#!/bin/sh\necho 0.9.0\n');

  createStubBin(join(ctx.directory, 'g', 'bin'), 'atc', '#!/bin/sh\necho 0.8.0\n');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
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
  const guestATC = createStubBin(join(ctx.directory, 'g', 'bin'), 'atc', '#!/bin/sh\necho 1.0.0\n');
  const log = mock(() => {});

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), guestATC: join(ctx.directory, 'missing-atc') },
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

test('it writes a read-only file through impd', async () => {
  const ctx = setupTest();

  ctx.port.readOnlyFilesDir = join(ctx.directory, 'ro');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  const path = await provider.writeReadOnlyFile('s1', 'notes/rota.json', '{"shift":"early"}');

  expect(path).toBe(join(ctx.directory, 'ro', 'atc-s1', 'notes', 'rota.json'));

  expect(readFileSync(join(ctx.directory, 'ro', 'atc-s1', 'notes', 'rota.json'), 'utf8')).toBe(
    '{"shift":"early"}',
  );
});

test('it has no read-only file on an imp whose agent is from before them', async () => {
  const ctx = setupTest();

  // the port holds no folder for read-only files, as an imp still on an
  // older agent

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  const path = await provider.writeReadOnlyFile('s1', 'notes/rota.json', '{}');

  expect(path).toBeNull();
});

test('it refuses a read-only file on an imp impd does not hold as the host refusal', async () => {
  const ctx = setupTest();

  ctx.port.readOnlyFilesDir = join(ctx.directory, 'ro');

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });
  await ctx.port.destroyImp('atc-s1');

  expect(provider.writeReadOnlyFile('s1', 'notes/rota.json', '{}')).rejects.toMatchObject({
    code: 'host_unavailable',
  });
});

test('it names each imp under the atc- prefix when the target sets none', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), impPrefix: 'harness-' },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), impPrefix: 'harness-' },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), impPrefix: 'harness-' },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

test('it starts a harness without CAP_SYS_ADMIN on a target that drops it', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), dropSysAdmin: true },
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
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await Promise.allSettled([harness.waitForStart()]);

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({ kind: 'start', name: 'atc-s1', dropSysAdmin: true }),
  ]);
});

test('it starts a harness with CAP_SYS_ADMIN on a target that leaves it', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  invariant(harness.waitForStart !== undefined, 'the imp harness reports no start');

  await Promise.allSettled([harness.waitForStart()]);

  const [start] = ctx.port.sessionRequests;

  invariant(start !== undefined, 'the harness sent no start');

  expect(Object.keys(start)).not.toContain('dropSysAdmin');
});

test('it refuses to ready an imp on an impd older than the oldest it supports, creating nothing', () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.version = '2.1.0';

  expect(provider.prepareHost({ host: 's1', daemonID: 'd1' })).rejects.toMatchObject({
    code: 'host_unavailable',
    message:
      'imp atc-s1 cannot be used: impd 2.1.0 is older than 2.2.0, the oldest impd this atc supports; upgrade impd to 2.2.0 or later',
    data: { provider: 'imp', problem: 'impd_outdated' },
  });

  expect(ctx.port.createSpecs).toStrictEqual([]);
});

test("it lays out atc's files under the scratch folder impd declares", async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    {},
    { atcBinary: '/opt/atc-build/atc', version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.scratchDir = '/var/lib/orchard-scratch';

  const guest = await provider.readGuest('s1');

  expect(guest).toStrictEqual({
    directory: '/var/lib/orchard-scratch/atc',
    atc: '/var/lib/orchard-scratch/atc/bin/atc',
  });
});

test("it readies atc's folder and listens for hooks under the scratch folder impd declares", async () => {
  const ctx = setupTest();
  const provider = createImpProvider(ctx.port, {}, { atcBinary: null, version: '1.0.0' });

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.scratchDir = join(ctx.directory, 'scratch');

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
    onRelay: () => {},
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  expect(ctx.port.calls).toIncludeAllMembers([
    `exec.run atc-s1 sh -c ${READY_GUEST_DIR_SCRIPT} sh ${join(ctx.directory, 'scratch', 'atc')} `,
    `reverse atc-s1 ${join(ctx.directory, 'scratch', 'atc', 'run', 's1.sock')}`,
  ]);
});

test('it refuses to ready an imp on an impd that declares no scratch folder, creating nothing', () => {
  const ctx = setupTest();
  const provider = createImpProvider(ctx.port, {}, { atcBinary: null, version: '1.0.0' });

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.scratchDir = null;

  expect(provider.prepareHost({ host: 's1', daemonID: 'd1' })).rejects.toMatchObject({
    code: 'host_unavailable',
    message:
      "imp atc-s1 cannot be used: impd 2.2.0 declares no guest scratch folder; upgrade impd, or set the target's guestDir",
    data: { provider: 'imp', problem: 'impd_outdated' },
  });

  expect(ctx.port.createSpecs).toStrictEqual([]);
});

test("it keeps the target's guest folder on an impd that declares no scratch folder", async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: '/srv/orchard-atc' },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.scratchDir = null;

  const guest = await provider.readGuest('s1');

  expect(guest).toStrictEqual({ directory: '/srv/orchard-atc', atc: null });
});

test("it refuses a guest layout read as the host's refusal on an impd that declares no scratch folder", () => {
  const ctx = setupTest();
  const provider = createImpProvider(ctx.port, {}, { atcBinary: null, version: '1.0.0' });

  registerTestCleanup(() => {
    provider.dispose();
  });

  ctx.port.scratchDir = null;

  expect(provider.readGuest('s1')).rejects.toMatchObject({
    code: 'host_unavailable',
    message:
      "imp atc-s1 cannot be used: impd 2.2.0 declares no guest scratch folder; upgrade impd, or set the target's guestDir",
    data: { provider: 'imp', problem: 'impd_outdated' },
  });
});

test('it starts a harness with a relative working directory under the guest home, which impd would resolve from the root', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  mkdirSync(join(ctx.directory, 'home', 'orchard'), { recursive: true });

  ctx.port.setHomeDir(join(ctx.directory, 'home'));

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'pwd',
    args: [],
    cwd: 'orchard',
    env: {},
    cols: 80,
    rows: 24,
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  const exited = Promise.withResolvers<void>();

  harness.onExit(() => {
    exited.resolve();
  });

  await exited.promise;

  expect(output.join('')).toBe(`${join(ctx.directory, 'home', 'orchard')}\r\n`);
});

test('it runs a command with a relative working directory under the guest home, which impd would resolve from the root', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await ctx.port.createImp({ name: 'atc-s1' });

  mkdirSync(join(ctx.directory, 'home', 'orchard'), { recursive: true });

  ctx.port.setHomeDir(join(ctx.directory, 'home'));

  const result = await provider.runCommand({ argv: ['pwd'], cwd: 'orchard', host: 's1' });

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: `${join(ctx.directory, 'home', 'orchard')}\n`,
    stderr: '',
  });
});

test('it keeps a full UUID imp session name inside the session limit', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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
    expect.stringMatching(/^start [a-z0-9][a-z0-9-]{0,31}$/u),
  ]);
});

test('it derives one imp session name per session', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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
    cwd: ctx.directory,
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
    cwd: ctx.directory,
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g'), image: 'base', memoryMib: 512 },
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

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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

  const wire = join(ctx.directory, 'wire.bin');
  const bin = join(ctx.directory, 'bin');

  createStubBin(bin, 'gzip', `#!/bin/sh\ntee '${wire}' | '${realGzip}' "$@"\n`);

  ctx.port.setGuestPath(`${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);

  const archive = buildTarArchive([{ path: 'src/a.txt', content: 'hello from the daemon' }]);

  await provider.transferArchive(archive, join(ctx.directory, 'w'), 's1');

  expect(readFileSync(join(ctx.directory, 'w', 'src', 'a.txt'), 'utf8')).toBe(
    'hello from the daemon',
  );

  expect(gunzipSync(readFileSync(wire))).toStrictEqual(Buffer.from(archive));
});

test('it refuses a transfer to an imp without gzip and leaves the directory uncreated', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  await provider.prepareHost({ host: 's1', daemonID: 'd1' });

  // The guest's PATH holds every tool the unpack runs except gzip.
  const bin = join(ctx.directory, 'bin');

  mkdirSync(bin);

  for (const tool of ['sh', 'mkdir', 'tar']) {
    const path = Bun.which(tool);

    invariant(path !== null);
    symlinkSync(path, join(bin, tool));
  }

  ctx.port.setGuestPath(bin);

  const archive = buildTarArchive([{ path: 'a.txt', content: 'never unpacked' }]);

  expect(
    provider.transferArchive(archive, join(ctx.directory, 'w'), 's1'),
  ).rejects.toThrowWithMessage(
    Error,
    `imp atc-s1 has no gzip, which unpacking the archive into ${join(ctx.directory, 'w')} needs; install gzip in its image`,
  );

  expect(existsSync(join(ctx.directory, 'w'))).toBe(false);
});

test("it logs the end of a harness's hook forward and listens on the guest socket again", async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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
    expect(existsSync(join(ctx.directory, 'g', 'run', 's1.sock'))).toBeTrue();
  });

  expect(lines).toContain(
    "imp atc-s1 stopped listening for session s1's hooks (closed 1006); listening again in 0ms",
  );
});

test('it listens on the guest socket no more once the harness ended', async () => {
  const ctx = setupTest();

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

  expect(existsSync(join(ctx.directory, 'g', 'run', 's1.sock'))).toBeFalse();

  expect(reverseCalls).toStrictEqual([
    `reverse atc-s1 ${join(ctx.directory, 'g', 'run', 's1.sock')}`,
  ]);
});

test('it leaves a hook forward that impd lost with the guest ended, so the imp sleeps on', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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
    `reverse atc-s1 ${join(ctx.directory, 'g', 'run', 's1.sock')}`,
  ]);
});

test('it leaves a hook forward ended when the imp starts to sleep during the wait to listen again', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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
      "imp atc-s1 is going to sleep; session s1's hooks listen again if the sleep is refused",
    );
  });

  await Promise.all(suspends);

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toStrictEqual([
    `reverse atc-s1 ${join(ctx.directory, 'g', 'run', 's1.sock')}`,
  ]);
});

test('it listens on the guest socket again when impd refuses the sleep that was pending as its hook forward ended', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

  ctx.port.acquireOtherLease('atc-s1', 'token:other', 'build', 60);

  // The sleep holds at its lease release until the forward has ended, so the
  // end arrives while the sleep is pending.
  ctx.port.startReleaseHold();

  registerTestCleanup(() => {
    ctx.port.stopReleaseHold();
  });

  const suspend = provider.suspendHost('s1');

  await waitFor(() => {
    expect(ctx.port.countHeldReleases()).toBe(1);
  });

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  await waitFor(() => {
    expect(lines).toContain(
      "imp atc-s1 is going to sleep; session s1's hooks listen again if the sleep is refused",
    );
  });

  ctx.port.stopReleaseHold();

  expect(suspend).rejects.toThrow();

  await waitFor(() => {
    expect(existsSync(join(ctx.directory, 'g', 'run', 's1.sock'))).toBeTrue();
  });

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toHaveLength(2);
});

test('it listens on the guest socket again when impd fails the destroy that was pending as its hook forward ended', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

  // The destroy holds at impd until the forward has ended, so the end
  // arrives while the destroy is pending.
  ctx.port.startDestroyHold();

  registerTestCleanup(() => {
    ctx.port.stopDestroyHold();
  });

  const destroy = provider.destroyHost('s1');

  await waitFor(() => {
    expect(ctx.port.countHeldDestroys()).toBe(1);
  });

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  await waitFor(() => {
    expect(lines).toContain(
      "imp atc-s1 is going to sleep; session s1's hooks listen again if the sleep is refused",
    );
  });

  ctx.port.setDestroyFailure('SERVICE_UNAVAILABLE');
  ctx.port.stopDestroyHold();

  expect(destroy).rejects.toThrow();

  await waitFor(() => {
    expect(existsSync(join(ctx.directory, 'g', 'run', 's1.sock'))).toBeTrue();
  });

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toHaveLength(2);
});

test('it listens on the guest socket no more when the daemon lets go of the harness as impd refuses the sleep its hook forward waits on', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  const provider = createImpProvider(
    ctx.port,
    { guestDir: join(ctx.directory, 'g') },
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
    cwd: ctx.directory,
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

  ctx.port.acquireOtherLease('atc-s1', 'token:other', 'build', 60);

  // The sleep holds at its lease release until the forward waits on it to
  // listen again, so the refusal settles that wait.
  ctx.port.startReleaseHold();

  registerTestCleanup(() => {
    ctx.port.stopReleaseHold();
  });

  // The refused sleep takes the daemon's lease back in the same turn that
  // settles the forward's wait, so the daemon lets go of the harness before
  // the wait's continuation runs.
  const unsubscribe = ctx.port.subscribeToLeaseAcquires(() => {
    harness.detach();
  });

  registerTestCleanup(unsubscribe);

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  await waitFor(() => {
    expect(lines).toContain(
      "imp atc-s1 is going to sleep; session s1's hooks listen again if the sleep is refused",
    );
  });

  ctx.port.stopReleaseHold();

  expect(Promise.all(suspends)).rejects.toThrow();
  expect(existsSync(join(ctx.directory, 'g', 'run', 's1.sock'))).toBeFalse();

  expect(ctx.port.calls.filter((call) => call.startsWith('reverse '))).toStrictEqual([
    `reverse atc-s1 ${join(ctx.directory, 'g', 'run', 's1.sock')}`,
  ]);
});
