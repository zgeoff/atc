/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { updateEnv } from '@atc/core/test-utils/update-env';
import { waitFor } from '@atc/core/test-utils/wait-for';
import type { AuthProfile, HarnessSpec } from '@atc/plugin-api';
import { formatRelayFrame, parseDaemonFrame } from '@atc/protocol/relay';
import type { GuestFrame } from '@atc/protocol/relay';
import type { SpritesTarget } from './config/parse-sprites-target';
import { createSpritesProvider } from './create-sprites-provider';
import { UNPACK_ARCHIVE_SCRIPT } from './guest-scripts/unpack-archive-script';
import type { SpritesPort } from './port/types';
import { BOOT_ID_PATH } from './provider/boot-id-path';
import { createInMemorySprites } from './test-utils/create-in-memory-sprites';

interface WelcomeAnswer {
  readonly ack: number;
  readonly reset: boolean;
}

function setupTest() {
  const sprite = 'atc-h1';
  const guestDir = '/home/sprite/.atc';
  const token = 'sprites-token-sentinel';

  const target: SpritesTarget = {
    token: { kind: 'env', name: 'SPRITES_TOKEN' },
    spritePrefix: 'atc-',
    apiURL: 'https://api.example.test',
    guestDir,
  };

  const profile: AuthProfile = {
    name: 'claude-sprites',
    secret: 'conn_example',
    kind: 'custom',
    host: 'api.anthropic.com',
    header: 'authorization',
    scheme: 'bearer',
    env: {},
    dependencies: [],
  };

  const directory = setupTempDir('atc-sprites-provider-');
  const binary = join(directory.path, 'atc');

  writeFileSync(binary, 'compiled-binary-bytes');

  const sprites = createInMemorySprites();
  const logged: string[] = [];

  sprites.addConnector({ id: 'conn_example', provider: 'custom_api', namePrefix: 'atc-' });

  // holds the second listExecs call after holdExecLists() until the returned release runs: the
  // relay's mux link lists first, and the harness lists next
  let held: Promise<void> | null = null;
  let listCalls = 0;

  // holds the second boot-id read after holdBootRead() until the returned release runs, and lists
  // the reads and exec lists that follow the hold: the relay's mux link reads first, and the
  // harness reads next
  let bootReads = 0;
  let heldBoot: Promise<void> | null = null;
  let isBootHeld = false;
  const afterBootHold: string[] = [];

  const heldSprites: SpritesPort = {
    ...sprites,
    readFile: (name, path) => {
      if (isBootHeld) {
        afterBootHold.push(`readFile ${path}`);
      }

      return sprites.readFile(name, path);
    },
    openExec: (name, request) => {
      if (isBootHeld) {
        afterBootHold.push(`openExec ${request.argv.join(' ')}`);
      }

      const connection = sprites.openExec(name, request);
      const gate = heldBoot;
      const isBootRead = request.argv.join(' ') === `cat ${BOOT_ID_PATH}`;

      if (gate === null || !isBootRead || isBootHeld) {
        return connection;
      }

      bootReads += 1;

      if (bootReads < 2) {
        return connection;
      }

      isBootHeld = true;

      return {
        ...connection,
        endInput: () => {
          void (async () => {
            await gate;

            afterBootHold.length = 0;

            connection.endInput();
          })();
        },
      };
    },
    listExecs: async (name) => {
      if (isBootHeld) {
        afterBootHold.push('listExecs');
      }

      if (held !== null) {
        listCalls += 1;

        if (listCalls > 1) {
          await held;
        }
      }

      return sprites.listExecs(name);
    },
  };

  const provider = createSpritesProvider(heldSprites, target, {
    targetID: 'box',
    atcBinary: binary,
    getBuild: () => 'build-1',
    reconnectDelaysMs: [0],
    log: (line) => {
      logged.push(line);
    },
  });

  onTestFinished(() => {
    provider.dispose();
  });

  const answeredHellos = new Map<string, number>();

  const readMuxFrames = (muxID: string) =>
    sprites
      .readInput(sprite, muxID)
      .split('\n')
      .flatMap((line) => {
        const frame = parseDaemonFrame(line);

        return frame === null ? [] : [frame];
      });

  const waitForMux = () =>
    waitFor(() => {
      const found = sprites.findExecID(sprite, 'relay-mux');

      expect(found).not.toBeNull();

      return found ?? '';
    });

  return {
    target,
    sprite,
    guestDir,
    token,
    profile,
    logged,
    directory: directory.path,
    binary,
    sprites,
    provider,
    request: { host: 'h1', daemonID: 'd-1' },
    spec: {
      session: 's1',
      host: 'h1',
      bin: 'sh',
      args: ['-c', 'claude'],
      cwd: '/home/sprite/work',
      env: {
        ATC_SESSION_ID: 's1',
        ATC_SOCKET: '/daemon/reporter.sock',
        ANTHROPIC_BASE_URL: 'https://api.example.test/v1/gateway/custom_api/conn_example',
        ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      },
      cols: 100,
      rows: 30,
      onRelay: () => {},
    } satisfies HarnessSpec,
    waitForMux,
    holdExecLists: () => {
      const gate = Promise.withResolvers<void>();

      held = gate.promise;

      return gate.resolve;
    },
    countExecLists: () => listCalls,
    holdBootRead: () => {
      const gate = Promise.withResolvers<void>();

      heldBoot = gate.promise;

      return gate.resolve;
    },
    isBootHeld: () => isBootHeld,
    readsAfterBootHold: () => [...afterBootHold],

    // the stand-in for the mux: answers the daemon's latest hello once it is on the mux's stdin
    guest: {
      welcome: async (_session: string, answer: WelcomeAnswer) => {
        const muxID = await waitForMux();

        const answered = answeredHellos.get(muxID) ?? 0;

        const hello = await waitFor(() => {
          const hellos = readMuxFrames(muxID).filter((frame) => frame.t === 'hello');

          expect(hellos.length).toBeGreaterThan(answered);

          return hellos.at(-1);
        });

        answeredHellos.set(muxID, answered + 1);

        sprites.writeOutput(
          sprite,
          muxID,
          formatRelayFrame({
            t: 'welcome',
            v: 1,
            relay: hello?.t === 'hello' ? hello.relay : '',
            gen: hello?.t === 'hello' ? hello.gen : 0,
            ack: answer.ack,
            reset: answer.reset,
          }),
        );
      },
      write: async (frame: GuestFrame) => {
        const muxID = await waitForMux();

        sprites.writeOutput(sprite, muxID, formatRelayFrame(frame));
      },
    },
    findHarnessExecID: () => sprites.findExecID(sprite, 'claude'),
  };
}

test('it declares the routed credentials and the capabilities of a suspendable remote host', () => {
  const ctx = setupTest();

  expect(ctx.provider).toMatchObject({
    kind: 'sprites',
    remote: true,
    credentials: { kind: 'routed', router: { hostPrefix: 'atc-' } },
    hostGitIdentity: true,
    capabilities: {
      spawn: true,
      attach: true,
      input: true,
      resize: true,
      kill: true,
      transfer: true,
      run: true,
      headless: false,
      suspend: true,
      destroy: true,
      relay: true,
    },
  });
});

test('it creates a sprite named by the prefix and the host key, with a host record and the binary', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const record = ctx.sprites.findFile(ctx.sprite, `${ctx.guestDir}/host.json`);
  const binary = ctx.sprites.findFile(ctx.sprite, `${ctx.guestDir}/bin/atc`);

  expect([
    ctx.sprites.hasSprite(ctx.sprite),
    new TextDecoder().decode(record?.content),
    new TextDecoder().decode(binary?.content),
    binary?.mode,
  ]).toStrictEqual([
    true,
    JSON.stringify({ target: 'box', host: 'h1', daemon: 'd-1' }),
    'compiled-binary-bytes',
    0o755,
  ]);
});

test('it reports the sprite name and its id as the host fact', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const view = await ctx.sprites.readSprite(ctx.sprite);

  expect(ctx.provider.findHostFact('h1')).toStrictEqual({ name: ctx.sprite, id: view?.id ?? '' });
});

test('it reports the guest folder and its binary, with no sign-in folder', async () => {
  const ctx = setupTest();

  const layout = await ctx.provider.readGuest('h1');

  expect(layout).toStrictEqual({
    directory: ctx.guestDir,
    atc: `${ctx.guestDir}/bin/atc`,
    signIn: null,
  });
});

test('it finds its own host again when a spawn retries, and uploads the binary once', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  writeFileSync(ctx.binary, 'changed-bytes');

  await ctx.provider.prepareHost(ctx.request);

  const binary = ctx.sprites.findFile(ctx.sprite, `${ctx.guestDir}/bin/atc`);

  expect(new TextDecoder().decode(binary?.content)).toBe('compiled-binary-bytes');
});

test('it refuses a host when a sprite of its name holds no host record', async () => {
  const ctx = setupTest();

  await ctx.sprites.createSprite(ctx.sprite);

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_exists' },
  });
});

test('it refuses a host when the record on a sprite of its name names another host', async () => {
  const ctx = setupTest();

  await ctx.sprites.createSprite(ctx.sprite);

  await ctx.sprites.writeFile(
    ctx.sprite,
    `${ctx.guestDir}/host.json`,
    new TextEncoder().encode(JSON.stringify({ target: 'other', host: 'h1', daemon: 'd-1' })),
    0o600,
  );

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_exists' },
  });
});

test('it refuses a host with the status and message of a Sprites API error', () => {
  const ctx = setupTest();

  ctx.sprites.failAll(500, 'the fleet is on fire');

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { status: 500 },
    message: expect.stringContaining('the fleet is on fire'),
  });
});

test('it refuses a spawn past an org limit with the API message', () => {
  const ctx = setupTest();

  ctx.sprites.refuseCreate(429, 'concurrent sprite limit of 10 reached');

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    message: expect.stringContaining('concurrent sprite limit of 10 reached'),
  });

  expect(ctx.sprites.hasSprite(ctx.sprite)).toBeFalse();
});

test('it deletes the sprite it created when readying it fails afterwards', async () => {
  const ctx = setupTest();

  const broken = createSpritesProvider(ctx.sprites, ctx.target, {
    targetID: 'box',
    atcBinary: join(ctx.directory, 'missing'),
    getBuild: () => 'build-1',
  });

  expect(broken.prepareHost(ctx.request)).rejects.toMatchObject({ code: 'host_unavailable' });

  await waitFor(() => {
    expect(ctx.sprites.hasSprite(ctx.sprite)).toBeFalse();
  });
});

test('it starts the relay mux in an exec that outlives its clients, and the harness in a terminal exec', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await harness.waitForStart?.();

  const started = ctx.sprites.requests
    .map((entry) => entry.request)
    .filter((request) => request.execID === undefined && request.argv.join(' ').includes('s1'));

  expect([start, started.map((request) => request.tty)]).toStrictEqual([
    { created: true },
    [false],
  ]);

  const mux = ctx.sprites.requests
    .map((entry) => entry.request)
    .find((request) => request.argv.includes('relay-mux'));

  expect(mux).toStrictEqual({
    argv: [`${ctx.guestDir}/bin/atc`, 'relay-mux', `${ctx.guestDir}/relay/s1.sock`],
    tty: false,
    outlivesClients: true,
  });

  const terminal = ctx.sprites.requests
    .map((entry) => entry.request)
    .find((request) => request.tty);

  expect(terminal).toStrictEqual({
    argv: ['sh', '-c', 'claude'],
    cwd: '/home/sprite/work',
    env: {
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      ATC_SESSION_ID: 's1',
      ANTHROPIC_BASE_URL: 'https://api.example.test/v1/gateway/custom_api/conn_example',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      ATC_SOCKET: `${ctx.guestDir}/relay/s1.sock`,
      ATC_BRIDGE: '1',
      ATC_OUTBOX: `${ctx.guestDir}/relay/s1.outbox`,
    },
    tty: true,
    cols: 100,
    rows: 30,
  });
});

test('it holds no credential value in any exec, file or command of a launch', async () => {
  const ctx = setupTest();

  updateEnv('SPRITES_TOKEN', ctx.token);

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const files = ['host.json', 'state/s1.json'].map((name) =>
    new TextDecoder().decode(ctx.sprites.findFile(ctx.sprite, `${ctx.guestDir}/${name}`)?.content),
  );

  expect(JSON.stringify([ctx.sprites.requests, files, ctx.logged])).not.toInclude(ctx.token);

  const terminal = ctx.sprites.requests.find((entry) => entry.request.tty)?.request;

  expect(
    Object.entries(terminal?.env ?? {}).filter(([key]) => key.startsWith('ANTHROPIC_')),
  ).toStrictEqual([
    ['ANTHROPIC_BASE_URL', 'https://api.example.test/v1/gateway/custom_api/conn_example'],
    ['ANTHROPIC_AUTH_TOKEN', 'broker-placeholder'],
  ]);
});

test('it records the exec ids of a session with the boot they ran under', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const stored = ctx.sprites.findFile(ctx.sprite, `${ctx.guestDir}/state/s1.json`);
  const boot = ctx.sprites.findBootID(ctx.sprite);

  expect(JSON.parse(new TextDecoder().decode(stored?.content))).toStrictEqual({
    harness: { exec: ctx.findHarnessExecID(), boot },
    mux: { exec: ctx.sprites.findExecID(ctx.sprite, 'relay-mux'), boot },
  });
});

test('it delivers each hook line once and in order across a dropped relay WebSocket', async () => {
  const ctx = setupTest();
  const lines: string[] = [];

  await ctx.provider.prepareHost(ctx.request);

  ctx.provider.spawnHarness({
    ...ctx.spec,
    onRelay: (relay) => {
      relay.onLine((line) => {
        lines.push(line);
      });
    },
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await ctx.guest.write({ t: 'open', seq: 1, conn: 1 });
  await ctx.guest.write({ t: 'line', seq: 2, conn: 1, line: 'one' });

  await waitFor(() => {
    expect(lines).toStrictEqual(['one']);
  });

  const muxID = await ctx.waitForMux();

  ctx.sprites.dropConnections(ctx.sprite, muxID);

  // the attach replays stdout from byte 0, so the guest's answer follows the old frames
  await ctx.guest.welcome('s1', { ack: 0, reset: false });
  await ctx.guest.write({ t: 'open', seq: 1, conn: 1 });
  await ctx.guest.write({ t: 'line', seq: 2, conn: 1, line: 'one' });
  await ctx.guest.write({ t: 'line', seq: 3, conn: 1, line: 'two' });

  await waitFor(() => {
    expect(lines).toStrictEqual(['one', 'two']);
  });
});

test('it follows the harness output and writes its input and size to the exec', async () => {
  const ctx = setupTest();
  const received: string[] = [];

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  harness.onData((data) => {
    received.push(data);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const execID = ctx.findHarnessExecID() ?? '';

  ctx.sprites.writeOutput(ctx.sprite, execID, 'hello from claude');
  harness.write('typed');

  await waitFor(() => {
    expect(received).toStrictEqual(['hello from claude']);
    expect(ctx.sprites.readInput(ctx.sprite, execID)).toBe('typed');
  });
});

test('it reattaches to the harness exec when its WebSocket drops, and replays the screen', async () => {
  const ctx = setupTest();
  const received: string[] = [];
  const attachments: string[] = [];

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  harness.onData((data) => {
    received.push(data);
  });

  harness.onAttachment?.((attachment) => {
    attachments.push(attachment);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const execID = ctx.findHarnessExecID() ?? '';

  ctx.sprites.writeOutput(ctx.sprite, execID, 'screen');
  ctx.sprites.dropConnections(ctx.sprite, execID);

  await waitFor(() => {
    expect(attachments).toStrictEqual(['reattaching', 'attached']);
    expect(received).toStrictEqual(['screen', 'screen']);
  });

  const attaches = ctx.sprites.requests.filter((entry) => entry.request.execID === execID);

  expect(attaches).toHaveLength(1);
});

test('it gives up after one retry per delay when the harness exec refuses every attach', async () => {
  const ctx = setupTest();
  const exits: unknown[] = [];

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const execID = ctx.findHarnessExecID() ?? '';

  ctx.sprites.refuseAttaches();
  ctx.sprites.dropConnections(ctx.sprite, execID);

  await waitFor(() => {
    expect(exits).toStrictEqual([
      { exitCode: 1, reason: 'ended', detail: 'the harness cannot be reattached' },
    ]);
  });

  const attaches = ctx.sprites.requests.filter((entry) => entry.request.execID === execID);

  expect(attaches).toHaveLength(2);
});

test('it opens no harness exec when it is detached while the sprite still lists its execs', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const release = ctx.holdExecLists();
  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  await waitFor(() => {
    expect(ctx.countExecLists()).toBe(2);
  });

  harness.detach();

  release();

  // one macrotask turn lets every in-memory call the start would make settle
  await setImmediate();

  expect(ctx.sprites.requests.filter((entry) => entry.request.tty)).toStrictEqual([]);
});

test('it stops its setup at once when it is detached while the boot read is held', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const release = ctx.holdBootRead();
  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  await waitFor(() => {
    expect(ctx.isBootHeld()).toBe(true);
  });

  harness.detach();

  release();

  // one macrotask turn lets every in-memory call the start would make settle
  await setImmediate();

  expect(ctx.readsAfterBootHold()).toStrictEqual([]);
  expect(ctx.sprites.requests.filter((entry) => entry.request.tty)).toStrictEqual([]);
});

test('it reports the harness exit when the exec exits', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);
  const exits: unknown[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  ctx.sprites.exitExec(ctx.sprite, ctx.findHarnessExecID() ?? '', 3);

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 3, reason: 'exited' }]);
  });
});

test('it leaves no exec attached when it puts the host to sleep, and the sprite sleeps', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();
  await ctx.provider.suspendHost('h1');

  const view = await ctx.sprites.readSprite(ctx.sprite);

  expect([ctx.sprites.countAttached(ctx.sprite), view?.status]).toStrictEqual([0, 'warm']);
});

test('it keeps a host awake that a session still runs on', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  expect(ctx.provider.suspendHost('h1', () => false)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'busy' },
  });
});

test('it attaches to the harness the sprite still runs after a kill, and starts nothing', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const first = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await first.waitForStart?.();

  const execID = ctx.findHarnessExecID() ?? '';

  ctx.sprites.writeOutput(ctx.sprite, execID, 'screen before the kill');

  await ctx.provider.suspendHost('h1');

  ctx.sprites.sleep(ctx.sprite);

  await ctx.provider.prepareHost(ctx.request);

  const received: string[] = [];
  const second = ctx.provider.spawnHarness({ ...ctx.spec, args: ['-c', 'claude --resume'] });

  second.onData((data) => {
    received.push(data);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await second.waitForStart?.();

  await waitFor(() => {
    expect(received).toStrictEqual(['screen before the kill']);
  });

  const harnessStarts = ctx.sprites.requests.filter(
    (entry) => entry.request.tty && entry.request.execID === undefined,
  );

  expect([start, harnessStarts]).toStrictEqual([
    { created: false },
    [
      expect.objectContaining({
        request: expect.objectContaining({ argv: ['sh', '-c', 'claude'] }),
      }),
    ],
  ]);
});

test('it starts the resume command when the sprite booted again since the harness was recorded', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const first = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await first.waitForStart?.();
  await ctx.provider.suspendHost('h1');

  ctx.sprites.changeBootID(ctx.sprite);

  const second = ctx.provider.spawnHarness({ ...ctx.spec, args: ['-c', 'claude --resume'] });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await second.waitForStart?.();

  const terminals = ctx.sprites.requests.filter(
    (entry) => entry.request.tty && entry.request.execID === undefined,
  );

  expect([start, terminals.map((entry) => entry.request.argv)]).toStrictEqual([
    { created: true },
    [
      ['sh', '-c', 'claude'],
      ['sh', '-c', 'claude --resume'],
    ],
  ]);
});

test('it reads the harness of a running sprite as kept', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const fates = await ctx.provider.readHarnessFates('h1', ['s1', 's2']);

  expect(fates).toStrictEqual(new Map([['s1', 'kept']]));
});

test('it reads no fate of a sleeping sprite and leaves its sessions unknown', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();
  await ctx.provider.suspendHost('h1');

  ctx.sprites.sleep(ctx.sprite);

  const fates = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect(fates).toStrictEqual(new Map());
});

test('it reads a harness lost when a running sprite booted again since it was recorded', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();
  await ctx.provider.suspendHost('h1');

  ctx.sprites.changeBootID(ctx.sprite);

  // a client of its own keeps the sprite running
  ctx.sprites.openExec(ctx.sprite, { argv: ['sleep', '60'], tty: false, outlivesClients: true });

  const fates = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect(fates).toStrictEqual(new Map([['s1', 'lost']]));
});

test('it deletes the sprite of a forgotten host', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);
  await ctx.provider.destroyHost('h1');

  expect(ctx.sprites.hasSprite(ctx.sprite)).toBeFalse();
});

test('it refuses to delete a sprite that holds no record of its host', async () => {
  const ctx = setupTest();

  await ctx.sprites.createSprite(ctx.sprite);

  expect(ctx.provider.destroyHost('h1')).rejects.toMatchObject({
    data: { problem: 'host_exists' },
  });

  expect(ctx.sprites.hasSprite(ctx.sprite)).toBeTrue();
});

test('it unpacks an archive through an exec that reads it on stdin', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const inputs: string[] = [];

  ctx.sprites.answerRuns((request, stdin) => {
    inputs.push(request.argv.join(' '), new TextDecoder().decode(stdin));

    return { exitCode: 0 };
  });

  await ctx.provider.transferArchive(new TextEncoder().encode('tar-bytes'), '/work/repo', 'h1');

  expect(inputs).toStrictEqual([`sh -c ${UNPACK_ARCHIVE_SCRIPT} sh /work/repo`, 'tar-bytes']);
});

test('it runs a command in the home of the sprite user and returns what it printed', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.sprites.answerRuns(() => ({ stdout: 'out', stderr: 'err', exitCode: 2 }));

  const result = await ctx.provider.runCommand({
    argv: ['git', 'status'],
    cwd: 'repo',
    host: 'h1',
  });

  const run = ctx.sprites.requests.at(-1)?.request;

  expect([result, run?.argv.slice(0, 2), run?.cwd]).toStrictEqual([
    { exitCode: 2, stdout: 'out', stderr: 'err' },
    ['sh', '-c'],
    '/',
  ]);
});

test('it writes a record read-only and reports its path in the guest folder', async () => {
  const ctx = setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const path = await ctx.provider.writeReadOnlyFile('h1', 'sessions/s1.json', '{}');

  expect([path, ctx.sprites.findFile(ctx.sprite, path)?.mode]).toStrictEqual([
    `${ctx.guestDir}/records/sessions/s1.json`,
    0o444,
  ]);
});

test('it refuses a record path that leaves the records folder', () => {
  const ctx = setupTest();

  expect(ctx.provider.writeReadOnlyFile('h1', '../escape', 'x')).rejects.toThrow('records folder');
});

test('it refuses a profile whose connector is missing before any sprite exists', () => {
  const ctx = setupTest();
  const router = ctx.provider.credentials.router;

  expect(router.verifyRoutes([{ ...ctx.profile, secret: 'conn_absent' }])).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'route_missing' },
  });

  expect(ctx.sprites.hasSprite(ctx.sprite)).toBeFalse();
});

test('it refuses a profile whose connector has no access policy name prefix', () => {
  const ctx = setupTest();

  ctx.sprites.addConnector({ id: 'conn_open', provider: 'custom_api', namePrefix: null });

  expect(
    ctx.provider.credentials.router.verifyRoutes([{ ...ctx.profile, secret: 'conn_open' }]),
  ).rejects.toMatchObject({ code: 'auth_target_unsupported', data: { problem: 'route_missing' } });
});

test('it refuses a profile whose connector policy does not admit the sprite prefix', () => {
  const ctx = setupTest();

  ctx.sprites.addConnector({ id: 'conn_other', provider: 'custom_api', namePrefix: 'team-' });

  expect(
    ctx.provider.credentials.router.verifyRoutes([{ ...ctx.profile, secret: 'conn_other' }]),
  ).rejects.toMatchObject({ code: 'auth_target_unsupported', data: { problem: 'route_missing' } });
});

test('it accepts a connector whose name prefix the sprite prefix starts with, reading connectors once', async () => {
  const ctx = setupTest();

  ctx.sprites.addConnector({ id: 'conn_wide', provider: 'custom_api', namePrefix: 'at' });

  await ctx.provider.credentials.router.verifyRoutes([
    ctx.profile,
    { ...ctx.profile, secret: 'conn_wide' },
  ]);

  expect(ctx.sprites.countReads()).toBe(1);
});

test('it routes each ctx.profile to the gateway URL of its connector', async () => {
  const ctx = setupTest();

  const routes = await ctx.provider.credentials.router.readRoutes([ctx.profile]);

  expect(routes).toStrictEqual({
    'claude-sprites': 'https://api.example.test/v1/gateway/custom_api/conn_example',
  });
});

test('it refuses a route read with the status and message of an API error', () => {
  const ctx = setupTest();

  ctx.sprites.failAll(401, 'bad token');

  expect(ctx.provider.credentials.router.verifyRoutes([ctx.profile])).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { status: 401 },
    message: expect.stringContaining('bad token'),
  });
});
