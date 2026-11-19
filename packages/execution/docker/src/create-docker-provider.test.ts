/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import type { HarnessSpec } from '@atc/plugin-api';
import { formatRelayFrame, parseDaemonFrame } from '@atc/protocol/relay';
import type { GuestFrame } from '@atc/protocol/relay';
import { createDockerProvider } from './create-docker-provider';
import { READ_HOME_SCRIPT } from './guest-scripts/read-home-script';
import { UNPACK_ARCHIVE_SCRIPT } from './guest-scripts/unpack-archive-script';
import { createInMemoryEngine } from './test-utils/create-in-memory-engine';

interface HelloAnswer {
  readonly ack: number;
  readonly reset: boolean;
}

async function setupTest() {
  const directory = setupTempDir('atc-docker-provider-');
  const engine = createInMemoryEngine();
  const runs: { cmd: readonly string[]; stdin: string; workingDir: string | undefined }[] = [];
  const boot = { id: 'boot-1' };
  const targetID = 'box';
  const logged: string[] = [];

  engine.addImage('example/agents:1');

  engine.answerRuns((spec, stdin) => {
    runs.push({
      cmd: spec.cmd,
      stdin: new TextDecoder().decode(stdin),
      workingDir: spec.workingDir,
    });

    return spec.cmd[2] === READ_HOME_SCRIPT
      ? { stdout: '/home/agent', exitCode: 0 }
      : { stdout: 'printed', exitCode: 0 };
  });

  await engine.createVolume({ name: 'atc-sign-in', labels: {} });

  const stateDir = join(directory.path, 'provider');

  const createProvider = () =>
    createDockerProvider(
      engine,
      {
        image: 'example/agents:1',
        socket: '/var/run/docker.sock',
        namePrefix: 'atc-',
        signInVolume: 'atc-sign-in',
        guestDir: '/atc',
      },
      {
        targetID,
        atcBinary: '/opt/atc/atc',
        stateDir,
        readBootID: () => boot.id,
        reconnectDelaysMs: [0],
        log: (line) => {
          logged.push(line);
        },
      },
    );

  const provider = createProvider();

  onTestFinished(() => {
    provider.dispose();
  });

  const buildLabels = (host: string, daemon: string, bootID: string, session?: string) => ({
    'atc.target': targetID,
    'atc.host': host,
    'atc.daemon': daemon,
    'atc.boot': bootID,
    ...(session === undefined ? {} : { 'atc.session': session }),
  });

  const answeredHellos = new Map<string, number>();

  const readSidecarFrames = (session: string) =>
    engine
      .readInput(`atc-${session}-relay`)
      .split('\n')
      .flatMap((line) => {
        const frame = parseDaemonFrame(line);

        return frame === null ? [] : [frame];
      });

  return {
    logged,
    directory: directory.path,
    stateDir,
    engine,
    runs,
    boot,
    provider,
    restartProvider: createProvider,
    request: { host: 'h1', daemonID: 'd-1' },
    spec: {
      session: 's1',
      host: 'h1',
      bin: 'sh',
      args: ['-c', 'claude --resume'],
      cwd: '/home/agent/.atc/s1',
      env: { ATC_SESSION_ID: 's1', ATC_SOCKET: '/daemon/reporter.sock' },
      cols: 100,
      rows: 30,
      onRelay: () => {},
    } satisfies HarnessSpec,

    // the stand-in for the mux in a session's sidecar
    guest: {
      // answers the daemon's latest hello once it is on the sidecar's stdin
      welcome: async (session: string, answer: HelloAnswer) => {
        const answered = answeredHellos.get(session) ?? 0;

        const hello = await waitFor(() => {
          const hellos = readSidecarFrames(session).filter((frame) => frame.t === 'hello');

          expect(hellos.length).toBeGreaterThan(answered);

          return hellos.at(-1);
        });

        answeredHellos.set(session, answered + 1);

        engine.writeOutput(
          `atc-${session}-relay`,
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
      write: (session: string, frame: GuestFrame) => {
        engine.writeOutput(`atc-${session}-relay`, formatRelayFrame(frame));
      },
    },

    seed: {
      volume: (name: string, labels: Record<string, string>) =>
        engine.createVolume({ name, labels }),
      harness: (session: string, status: 'running' | 'paused' | 'exited', bootID: string) => {
        const exitCode = status === 'exited' ? 1 : 0;

        engine.seedContainer(
          {
            name: `atc-${session}`,
            image: 'example/agents:1',
            labels: buildLabels('h1', 'd-1', bootID, session),
            cmd: ['claude'],
            env: {},
            tty: true,
            stdin: 'held',
            mounts: [],
          },
          status,
          exitCode,
        );
      },
      sidecar: (session: string, status: 'running' | 'exited') => {
        engine.seedContainer(
          {
            name: `atc-${session}-relay`,
            image: 'example/agents:1',
            labels: buildLabels('h1', 'd-1', 'boot-1', session),
            cmd: ['/atc/bin/atc', 'relay-mux'],
            env: {},
            tty: false,
            stdin: 'held',
            mounts: [],
          },
          status,
        );
      },
    },
    buildLabels,
  };
}

test('it declares the stored-token credentials and the capabilities of a suspendable remote host', async () => {
  const ctx = await setupTest();

  expect(ctx.provider).toMatchObject({
    kind: 'docker',
    remote: true,
    credentials: { kind: 'stored-token' },
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

test('it creates a host volume and a relay volume with the labels of the host', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  expect(ctx.engine.collectVolumes()).toStrictEqual([
    { name: 'atc-sign-in', labels: {} },
    {
      name: 'atc-h1',
      labels: { ...ctx.buildLabels('h1', 'd-1', 'boot-1'), 'atc.host-id': expect.any(String) },
    },
    { name: 'atc-h1-relay', labels: ctx.buildLabels('h1', 'd-1', 'boot-1'), shared: true },
  ]);
});

test('it reports the host volume and its id as the host fact', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const volume = await ctx.engine.readVolume('atc-h1');

  const hostID = volume?.labels['atc.host-id'] ?? '';

  expect(ctx.provider.findHostFact('h1')).toStrictEqual({ name: 'atc-h1', id: hostID });
});

test('it reports the guest folder in the home of the image user and the sign-in folder', async () => {
  const ctx = await setupTest();
  const layout = await ctx.provider.readGuest('h1');

  expect(layout).toStrictEqual({
    directory: '/home/agent/.atc',
    atc: '/atc/bin/atc',
    signIn: '/atc/sign-in',
  });
});

test('it finds its own host again when a spawn retries', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  expect(ctx.provider.prepareHost(ctx.request)).resolves.toBeUndefined();
});

test('it refuses a host when the Engine lacks the image', async () => {
  const ctx = await setupTest();

  ctx.engine.removeImage('example/agents:1');

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'image_missing', image: 'example/agents:1' },
  });
});

test('it refuses a host when the Engine does not answer at its socket', async () => {
  const ctx = await setupTest();

  ctx.engine.setUnreachable(true);

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'engine_unreachable', socket: '/var/run/docker.sock' },
  });
});

test('it refuses a host when the Engine does not run Linux', async () => {
  const ctx = await setupTest();

  ctx.engine.setInfo({ osType: 'windows', architecture: 'x86_64' });

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'engine_unsupported' },
  });
});

test('it refuses a host when the Engine runs another architecture than the daemon', async () => {
  const ctx = await setupTest();

  ctx.engine.setInfo({ osType: 'linux', architecture: 'riscv64' });

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'engine_unsupported' },
  });
});

test('it refuses a host when the sign-in volume is missing', async () => {
  const ctx = await setupTest();

  await ctx.engine.removeVolume('atc-sign-in');

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'sign_in_missing', volume: 'atc-sign-in' },
  });
});

test('it refuses a host when the sign-in volume holds no token file', async () => {
  const ctx = await setupTest();

  ctx.engine.answerRuns((spec) =>
    spec.cmd[2] === READ_HOME_SCRIPT ? { stdout: '/home/agent', exitCode: 0 } : { exitCode: 1 },
  );

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'sign_in_missing', volume: 'atc-sign-in' },
  });
});

test('it refuses a host when the image user has no home folder of its own', async () => {
  const ctx = await setupTest();

  ctx.engine.answerRuns(() => ({ stdout: '/', exitCode: 0 }));

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'image_user_unusable' },
  });
});

test('it refuses a host when a volume of its name belongs to no host of the target', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', {});

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_exists' },
  });
});

test('it refuses a host when a volume of its name belongs to another target', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', { 'atc.target': 'other', 'atc.host': 'h1' });

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_exists' },
  });
});

test('it refuses a host that another daemon holds', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', ctx.buildLabels('h1', 'd-2', 'boot-1'));

  expect(ctx.provider.prepareHost(ctx.request)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_leased' },
  });
});

test('it refuses to forget a host that another daemon holds and leaves its volumes', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', ctx.buildLabels('h1', 'd-2', 'boot-1'));

  expect(ctx.provider.destroyHost('h1')).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_leased' },
  });

  expect(ctx.engine.collectVolumes().map((volume) => volume.name)).toContain('atc-h1');
});

test('it refuses to put to sleep a host that another daemon holds', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', ctx.buildLabels('h1', 'd-2', 'boot-1'));

  expect(ctx.provider.suspendHost('h1')).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'host_leased' },
  });
});

test('it forgets a host of its own after the daemon restarted, by the id it recorded', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const restarted = ctx.restartProvider();

  expect(restarted.destroyHost('h1')).resolves.toBeUndefined();
});

test('it keeps a host awake that a session still runs on', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  expect(ctx.provider.suspendHost('h1', () => false)).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'busy' },
  });
});

test('it pauses each container of a host when it puts the host to sleep', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.seed.harness('s1', 'running', 'boot-1');
  ctx.seed.sidecar('s1', 'running');

  await ctx.provider.suspendHost('h1');

  const states = await ctx.engine.listContainers({ 'atc.host': 'h1' });

  expect(states.map((container) => container.status)).toStrictEqual(['paused', 'paused']);
});

test('it unpauses the containers of a host when it readies the host again', async () => {
  const ctx = await setupTest();

  ctx.seed.harness('s1', 'paused', 'boot-1');

  await ctx.provider.prepareHost(ctx.request);

  const read = await ctx.engine.readContainer('atc-s1');

  expect(read?.status).toBe('running');
});

test('it removes the containers, the volumes and the records folder of a forgotten host and keeps the sign-in volume', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);
  await ctx.provider.writeReadOnlyFile('h1', 'atc/records/s1.json', '{}');

  ctx.seed.harness('s1', 'running', 'boot-1');
  ctx.seed.sidecar('s1', 'running');

  await ctx.provider.destroyHost('h1');

  expect([
    ctx.engine.collectContainers(),
    ctx.engine.collectVolumes().map((volume) => volume.name),
    existsSync(join(ctx.stateDir, 'records', 'h1')),
  ]).toStrictEqual([[], ['atc-sign-in'], false]);
});

test('it writes a record into the records folder read-only and reports its path in the container', async () => {
  const ctx = await setupTest();
  const path = await ctx.provider.writeReadOnlyFile('h1', 'atc/records/s1.json', '{"a":1}');

  const file = join(ctx.stateDir, 'records', 'h1', 'atc', 'records', 's1.json');

  expect([path, readFileSync(file, 'utf8'), statSync(file).mode & 0o777]).toStrictEqual([
    '/atc/records/atc/records/s1.json',
    '{"a":1}',
    0o444,
  ]);
});

test('it refuses a record path that leaves the records folder', async () => {
  const ctx = await setupTest();

  expect(ctx.provider.writeReadOnlyFile('h1', '../escape.json', '{}')).rejects.toThrow();
});

test('it unpacks an archive through a throwaway container that reads it on stdin', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.runs.length = 0;

  await ctx.provider.transferArchive(
    new TextEncoder().encode('tar bytes'),
    '/home/agent/.atc/s1',
    'h1',
  );

  expect(ctx.runs).toStrictEqual([
    {
      cmd: ['sh', '-c', UNPACK_ARCHIVE_SCRIPT, 'sh', '/home/agent/.atc/s1'],
      stdin: 'tar bytes',
      workingDir: undefined,
    },
  ]);
});

test('it runs a command in the home of the image user and returns what it printed', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.runs.length = 0;

  const result = await ctx.provider.runCommand({
    argv: ['git', 'status'],
    cwd: 'work',
    host: 'h1',
  });

  expect([result, ctx.runs.map((run) => run.cmd.slice(0, 2))]).toStrictEqual([
    { exitCode: 0, stdout: 'printed', stderr: '' },
    [['sh', '-c']],
  ]);
});

test.each([
  ['a running container', 'running', 'boot-1', 'kept'],
  ['a paused container', 'paused', 'boot-1', 'kept'],
  ['an exited container of an earlier boot', 'exited', 'boot-0', 'lost'],
  ['an exited container of this boot', 'exited', 'boot-1', undefined],
] as const)('it reads %s as the fate %s', async (_label, status, bootID, fate) => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.seed.harness('s1', status, bootID);

  const fates = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect(fates.get('s1')).toBe(fate);
});

test('it reads a session with no container as lost', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const fates = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect(fates.get('s1')).toBe('lost');
});

test('it lists no fate for a sleeping session once the Engine restarted on the same boot', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.seed.harness('s1', 'paused', 'boot-1');

  const before = await ctx.provider.readHarnessFates('h1', ['s1']);

  ctx.engine.restart();

  const after = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect([before.get('s1'), after.get('s1')]).toStrictEqual(['kept', undefined]);
});

test('it reads a sleeping session as lost once the machine booted again', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.seed.harness('s1', 'paused', 'boot-1');
  ctx.engine.restart();

  ctx.boot.id = 'boot-2';

  const fates = await ctx.provider.readHarnessFates('h1', ['s1']);

  expect(fates.get('s1')).toBe('lost');
});

test('it reads no fate of a host that another daemon holds', async () => {
  const ctx = await setupTest();

  await ctx.seed.volume('atc-h1', ctx.buildLabels('h1', 'd-2', 'boot-1'));

  expect(ctx.provider.readHarnessFates('h1', ['s1'])).rejects.toMatchObject({
    data: { problem: 'host_leased' },
  });
});

test('it starts the harness in a container of its own once the relay listens', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await harness.waitForStart?.();

  expect(start).toStrictEqual({ created: true });

  const created = ctx.engine.collectCreated().find((spec) => spec.name === 'atc-s1');

  expect(created).toStrictEqual({
    name: 'atc-s1',
    image: 'example/agents:1',
    labels: ctx.buildLabels('h1', 'd-1', 'boot-1', 's1'),
    cmd: ['sh', '-c', 'claude --resume'],
    env: {
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      ATC_SESSION_ID: 's1',
      ATC_SOCKET: '/atc/relay/s1.sock',
      ATC_BRIDGE: '1',
      ATC_OUTBOX: '/atc/relay/s1.outbox',
    },
    workingDir: '/home/agent/.atc/s1',
    tty: true,
    stdin: 'held',
    size: { cols: 100, rows: 30 },
    mounts: [
      { kind: 'volume', source: 'atc-h1', target: '/home/agent', readOnly: false },
      { kind: 'volume', source: 'atc-sign-in', target: '/atc/sign-in', readOnly: true },
      { kind: 'bind', source: '/opt/atc/atc', target: '/atc/bin/atc', readOnly: true },
      {
        kind: 'bind',
        source: join(ctx.stateDir, 'records', 'h1'),
        target: '/atc/records',
        readOnly: true,
      },
      { kind: 'volume', source: 'atc-h1-relay', target: '/atc/relay', readOnly: false },
    ],
  });
});

test('it runs the relay mux in a sidecar that keeps its stdin open when an attach ends', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  ctx.provider.spawnHarness(ctx.spec);

  await waitFor(() => {
    expect(ctx.engine.collectContainers().map((spec) => spec.name)).toContain('atc-s1-relay');
  });

  const sidecar = ctx.engine.collectContainers().find((spec) => spec.name === 'atc-s1-relay');

  expect(sidecar).toStrictEqual({
    name: 'atc-s1-relay',
    image: 'example/agents:1',
    labels: ctx.buildLabels('h1', 'd-1', 'boot-1', 's1'),
    cmd: ['/atc/bin/atc', 'relay-mux', '/atc/relay/s1.sock'],
    env: {},
    tty: false,
    stdin: 'held',
    mounts: [
      { kind: 'volume', source: 'atc-h1-relay', target: '/atc/relay', readOnly: false },
      { kind: 'bind', source: '/opt/atc/atc', target: '/atc/bin/atc', readOnly: true },
    ],
  });
});

test('it sets no token in the environment or the command of any container it creates', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  const everything = JSON.stringify(ctx.engine.collectCreated());

  expect(everything).not.toInclude('OAUTH');
});

test('it attaches to a harness the Engine still runs and starts nothing', async () => {
  const ctx = await setupTest();

  ctx.seed.harness('s1', 'running', 'boot-1');

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await harness.waitForStart?.();

  const names = ctx.engine.collectCreated().map((spec) => spec.name);

  expect([start, names.filter((name) => !name.includes('-run-'))]).toStrictEqual([
    { created: false },
    ['atc-s1-relay'],
  ]);
});

test('it removes an exited harness container and starts the resume command in a new one', async () => {
  const ctx = await setupTest();

  ctx.seed.harness('s1', 'exited', 'boot-1');

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const start = await harness.waitForStart?.();
  const read = await ctx.engine.readContainer('atc-s1');

  expect([start, read?.status, ctx.engine.collectCreated().at(-1)?.cmd]).toStrictEqual([
    { created: true },
    'running',
    ['sh', '-c', 'claude --resume'],
  ]);
});

test('it creates a new sidecar when the sidecar stopped and its harness container runs', async () => {
  const ctx = await setupTest();

  ctx.seed.harness('s1', 'running', 'boot-1');
  ctx.seed.sidecar('s1', 'exited');

  await ctx.provider.prepareHost(ctx.request);

  ctx.provider.spawnHarness(ctx.spec);

  await waitFor(() => {
    const names = ctx.engine.collectCreated().map((spec) => spec.name);

    expect(names.filter((name) => !name.includes('-run-'))).toStrictEqual(['atc-s1-relay']);
  });

  const read = await ctx.engine.readContainer('atc-s1-relay');

  expect(read?.status).toBe('running');
});

test('it follows the harness output and writes its input and size to the container', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);
  const output: string[] = [];

  harness.onData((text) => {
    output.push(text);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  ctx.engine.writeOutput('atc-s1', 'hello');
  harness.write('typed');
  harness.resize(120, 40);

  await waitFor(() => {
    expect(output).toStrictEqual(['hello']);
    expect(ctx.engine.readInput('atc-s1')).toBe('typed');
    expect(ctx.engine.readSizes('atc-s1').at(-1)).toStrictEqual({ cols: 120, rows: 40 });
  });
});

test('it reports the exit of the harness container', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);
  const exits: unknown[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  ctx.engine.exitContainer('atc-s1', 3);

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 3, reason: 'exited' }]);
  });
});

test('it reports the harness as ended when the host loses the mux before its first welcome', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);
  const exits: unknown[] = [];

  harness.onExit((exit) => {
    exits.push(exit);
  });

  await waitFor(() => {
    expect(ctx.engine.collectContainers().map((spec) => spec.name)).toContain('atc-s1-relay');
  });

  ctx.engine.exitContainer('atc-s1-relay', 1);

  await waitFor(() => {
    expect(exits).toStrictEqual([{ exitCode: 1, reason: 'ended', detail: expect.any(String) }]);
  });
});

test('it leaves the harness container running when the daemon lets go of it', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);

  await ctx.guest.welcome('s1', { ack: 0, reset: true });
  await harness.waitForStart?.();

  harness.detach();

  const read = await ctx.engine.readContainer('atc-s1');

  expect([read?.status, ctx.engine.countAttachments('atc-s1')]).toStrictEqual(['running', 0]);
});

test('it delivers each hook line once and in order across a dropped sidecar attach', async () => {
  const ctx = await setupTest();

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

  ctx.guest.write('s1', { t: 'open', seq: 1, conn: 1 });
  ctx.guest.write('s1', { t: 'line', seq: 2, conn: 1, line: 'one' });

  await waitFor(() => {
    expect(lines).toStrictEqual(['one']);
  });

  ctx.engine.dropAttachments('atc-s1-relay');

  await ctx.guest.welcome('s1', { ack: 0, reset: false });

  ctx.guest.write('s1', { t: 'open', seq: 1, conn: 1 });
  ctx.guest.write('s1', { t: 'line', seq: 2, conn: 1, line: 'one' });
  ctx.guest.write('s1', { t: 'line', seq: 3, conn: 1, line: 'two' });

  await waitFor(() => {
    expect(lines).toStrictEqual(['one', 'two']);
  });
});

test('it confirms an existing host of its own and refuses one of another daemon', async () => {
  const ctx = await setupTest();

  await ctx.provider.prepareHost(ctx.request);

  const own = await ctx.provider.checkExistingHost('h1');

  await ctx.seed.volume('atc-h2', ctx.buildLabels('h2', 'd-2', 'boot-1'));

  const other = await ctx.provider.checkExistingHost('h2');

  expect([own, other]).toStrictEqual([true, false]);
});

test('it refuses a sidecar-named container that carries another target and host, and keeps it', async () => {
  const ctx = await setupTest();

  ctx.engine.seedContainer(
    {
      name: 'atc-s1-relay',
      image: 'example/agents:1',
      labels: { 'atc.target': 'other', 'atc.host': 'x1', 'atc.daemon': 'd-2' },
      cmd: [],
      env: {},
      tty: false,
      stdin: 'held',
      mounts: [],
    },
    'exited',
  );

  await ctx.provider.prepareHost(ctx.request);

  ctx.provider.spawnHarness(ctx.spec);

  await waitFor(() => {
    expect(ctx.logged).toSatisfyAny((line: string) => line.includes('relay link did not open'));
  });

  const kept = await ctx.engine.readContainer('atc-s1-relay');

  expect(kept?.labels['atc.target']).toBe('other');
});

test('it refuses to replace an exited harness-named container that carries another target', async () => {
  const ctx = await setupTest();

  ctx.engine.seedContainer(
    {
      name: 'atc-s1',
      image: 'example/agents:1',
      labels: { 'atc.target': 'other', 'atc.host': 'x1', 'atc.daemon': 'd-2' },
      cmd: [],
      env: {},
      tty: true,
      stdin: 'held',
      mounts: [],
    },
    'exited',
  );

  await ctx.provider.prepareHost(ctx.request);

  const harness = ctx.provider.spawnHarness(ctx.spec);
  const exited = Promise.withResolvers<string>();

  harness.onExit((exit) => {
    exited.resolve(exit.detail ?? '');
  });

  await ctx.guest.welcome('s1', { ack: 0, reset: true });

  const kept = await ctx.engine.readContainer('atc-s1');

  expect([await exited.promise, kept?.labels['atc.target']]).toStrictEqual([
    expect.stringContaining('start failed'),
    'other',
  ]);
});
