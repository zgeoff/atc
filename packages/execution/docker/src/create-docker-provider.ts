import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStepTimer, makeKeyedLock } from '@atc/core';
import type {
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessSpec,
  HostCredentials,
  HostFact,
  HostRequest,
} from '@atc/plugin-api';
import { EffectRemainsError, openStreamRelay } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import type { DaemonError } from '@atc/protocol/wire';
import { SESSION_ENV_NAMES } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import type { DockerTarget } from './config/parse-docker-target';
import type { ContainerInfo, DockerEngine, Labels } from './engine/types';
import { READ_HOME_SCRIPT } from './guest-scripts/read-home-script';
import { UNPACK_ARCHIVE_SCRIPT } from './guest-scripts/unpack-archive-script';
import { buildContainerMounts } from './provider/build-container-mounts';
import type { ContainerRole, MountSources } from './provider/build-container-mounts';
import { buildHomeRelativeCommand } from './provider/build-home-relative-command';
import { buildHostNames } from './provider/build-host-names';
import { buildHostRefusal } from './provider/build-host-refusal';
import { buildObjectLabels } from './provider/build-object-labels';
import { buildSessionNames } from './provider/build-session-names';
import { collectHarnessFates } from './provider/collect-harness-fates';
import { createDaemonRecord } from './provider/create-daemon-record';
import { createDockerHarness } from './provider/create-docker-harness';
import { makeSidecarLink } from './provider/make-sidecar-link';
import { readBootID as readMachineBootID } from './provider/read-boot-id';
import { requireDockerEngine } from './provider/require-docker-engine';
import { requireHostObjects } from './provider/require-host-objects';
import { requireSignIn } from './provider/require-sign-in';
import { runThrowawayContainer } from './provider/run-throwaway-container';
import { toDockerRefusal } from './provider/to-docker-refusal';
import { writeRecordFile } from './provider/write-record-file';

export interface DockerProvider extends ExecutionProvider {
  readonly kind: 'docker';
  readonly credentials: Extract<HostCredentials, { readonly kind: 'stored-token' }>;
  readonly readGuest: (host: string) => Promise<GuestLayout>;
  readonly findHostFact: (host: string) => HostFact;
  readonly checkExistingHost: (host: string) => Promise<boolean>;
  readonly writeReadOnlyFile: (host: string, path: string, content: string) => Promise<string>;
  readonly readHarnessFates: NonNullable<ExecutionProvider['readHarnessFates']>;
  readonly dispose: () => void;
}

interface DockerProviderOptions {
  // the id of the target the provider serves, which every object it creates is labelled with
  readonly targetID: string;

  // the daemon's compiled binary, which each container mounts read-only
  readonly atcBinary: string;

  // the provider's own folder under the daemon's state
  readonly stateDir: string;

  // the id of the current boot of the daemon's machine, or null on a machine that keeps none
  readonly readBootID?: () => string | null;

  // the wait before each reconnect to a harness or a sidecar whose attach ended
  readonly reconnectDelaysMs?: readonly number[];
  readonly log?: (line: string) => void;
}

const RECONNECT_DELAYS_MS: readonly number[] = [250, 1000, 2000, 4000];

const capabilities: ExecutionCapabilities = {
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
};

export function createDockerProvider(
  engine: DockerEngine,
  target: DockerTarget,
  options: DockerProviderOptions,
): DockerProvider {
  const log = options.log ?? (() => {});
  const readBootID = options.readBootID ?? readMachineBootID;
  const reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const daemonRecord = createDaemonRecord(options.stateDir);
  const withHostTurn = makeKeyedLock();

  const hostIDs = new Map<string, string>();
  const harnesses = new Set<{ readonly detach: () => void }>();

  // the home folder of the image's user, by the id of the image it was read from
  const homes = new Map<string, string>();

  let latestHome: string | null = null;
  const buildRecordsDir = (host: string): string => join(options.stateDir, 'records', host);
  const toRefusal = (error: unknown): DaemonError => toDockerRefusal(error, target.socket);
  const requireEngine = (): Promise<string> => requireDockerEngine(engine, target, readBootID());

  const readHome = async (): Promise<string> => {
    const image = await engine.readImage(target.image);

    if (image === null) {
      throw buildHostRefusal('image_missing', `the Docker Engine holds no image ${target.image}`, {
        image: target.image,
      });
    }

    const known = homes.get(image.id);

    if (known !== undefined) {
      latestHome = known;

      return known;
    }

    const result = await runThrowawayContainer(engine, {
      namePrefix: target.namePrefix,
      image: target.image,
      labels: {},
      cmd: ['sh', '-c', READ_HOME_SCRIPT],
      mounts: [],
    });

    const home = new TextDecoder().decode(result.stdout);

    if (result.exitCode !== 0 || home === '' || home === '/') {
      throw buildHostRefusal(
        'image_user_unusable',
        `image ${target.image} runs as a user with no home folder of its own, and a host volume needs one to mount at`,
        { image: target.image },
      );
    }

    homes.set(image.id, home);

    latestHome = home;

    return home;
  };

  const getHome = (): string => {
    invariant(
      latestHome !== null,
      'the docker provider reads the image home before it starts a container',
    );

    return latestHome;
  };

  const buildIdentity = (host: string, daemon: string, bootID: string) => ({
    target: options.targetID,
    host,
    daemon,
    boot: bootID,
  });

  const readOwnDaemon = (): string | null => daemonRecord.read();

  const listHostContainers = (host: string): Promise<readonly ContainerInfo[]> =>
    engine.listContainers({ 'atc.target': options.targetID, 'atc.host': host });

  const toGuestLayout = (home: string): GuestLayout => ({
    directory: `${home}/.atc`,
    atc: `${target.guestDir}/bin/atc`,
    signIn: `${target.guestDir}/sign-in`,
  });

  const buildMountSources = (host: string): MountSources => ({
    target,
    names: buildHostNames(target, host),
    home: getHome(),
    atcBinary: options.atcBinary,
    recordsDir: buildRecordsDir(host),
  });

  const readHostLabels = (host: string): Labels => {
    const daemon = readOwnDaemon();

    invariant(daemon !== null, 'a host is readied before a container of it is created');

    return buildObjectLabels(buildIdentity(host, daemon, readBootID() ?? ''));
  };

  const runOnHost = async (
    host: string | undefined,
    command: Readonly<{ argv: readonly string[]; cwd?: string; stdin?: Uint8Array }>,
  ) => {
    if (host === undefined) {
      throw new Error('the docker provider runs a command only on a session host');
    }

    try {
      await readHome();

      return await runThrowawayContainer(engine, {
        namePrefix: target.namePrefix,
        image: target.image,
        labels: readHostLabels(host),
        cmd: command.argv,
        ...(command.cwd === undefined ? {} : { workingDir: command.cwd }),
        mounts: buildContainerMounts(buildMountSources(host), 'run'),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      });
    } catch (error) {
      throw toRefusal(error);
    }
  };

  const requireOwnHost = async (host: string): Promise<void> => {
    try {
      await requireHostObjects(engine, target, {
        targetID: options.targetID,
        host,
        daemon: readOwnDaemon(),
      });
    } catch (error) {
      throw toRefusal(error);
    }
  };

  const prepareHostInTurn = async (request: HostRequest): Promise<void> => {
    const timer = request.timer ?? createStepTimer();
    const names = buildHostNames(target, request.host);
    const created: { kind: 'volume'; name: string }[] = [];

    try {
      daemonRecord.write(request.daemonID);

      const bootID = await timer.withStep('docker-engine', requireEngine);

      await timer.withStep('docker-image', readHome);
      await timer.withStep('docker-sign-in', () => requireSignIn(engine, target));

      await requireHostObjects(engine, target, {
        targetID: options.targetID,
        host: request.host,
        daemon: request.daemonID,
      });

      const identity = buildIdentity(request.host, request.daemonID, bootID);

      const hostVolume = await engine.readVolume(names.hostVolume);

      await timer.withStep('docker-volumes', async () => {
        if (hostVolume === null) {
          const hostID = randomUUID();

          await engine.createVolume({
            name: names.hostVolume,
            labels: buildObjectLabels(identity, { hostID }),
          });

          created.push({ kind: 'volume', name: names.hostVolume });
          hostIDs.set(request.host, hostID);
        } else {
          hostIDs.set(request.host, hostVolume.labels['atc.host-id'] ?? '');
        }

        if ((await engine.readVolume(names.relayVolume)) === null) {
          await engine.createVolume({
            name: names.relayVolume,
            labels: buildObjectLabels(identity),
            shared: true,
          });

          created.push({ kind: 'volume', name: names.relayVolume });
        }
      });

      mkdirSync(buildRecordsDir(request.host), { recursive: true, mode: 0o755 });

      for (const container of await listHostContainers(request.host)) {
        if (container.status === 'paused') {
          await engine.unpauseContainer(container.name);
        }
      }
    } catch (error) {
      const refusal = toRefusal(error);

      const undone = await tryRemoveVolumes(created.map((object) => object.name));

      if (!undone) {
        throw new EffectRemainsError(
          `host ${request.host} failed to ready and removing the volumes it created failed too`,
          { cause: refusal },
        );
      }

      throw refusal;
    }
  };

  const tryRemoveVolumes = async (volumes: readonly string[]): Promise<boolean> => {
    try {
      for (const volume of volumes) {
        await engine.removeVolume(volume);
      }

      return true;
    } catch {
      return false;
    }
  };

  const planHarnessContainer = (spec: HarnessSpec, role: ContainerRole) => {
    const names = buildSessionNames(target, spec.session);
    const host = spec.host;
    const labels = { ...readHostLabels(host), 'atc.session': spec.session };
    const mounts = buildContainerMounts(buildMountSources(host), role);

    return { names, labels, mounts };
  };

  return {
    kind: 'docker',
    remote: true,
    capabilities,
    credentials: { kind: 'stored-token' },
    hostGitIdentity: true,

    readGuest: async () => {
      try {
        await requireEngine();

        const home = await readHome();

        return toGuestLayout(home);
      } catch (error) {
        throw toRefusal(error);
      }
    },

    prepareHost: (request) => withHostTurn(request.host, () => prepareHostInTurn(request)),

    checkExistingHost: async (host) => {
      try {
        const volume = await engine.readVolume(buildHostNames(target, host).hostVolume);

        const daemon = readOwnDaemon();

        if (volume === null) {
          hostIDs.delete(host);

          return false;
        }

        hostIDs.set(host, volume.labels['atc.host-id'] ?? '');

        return (
          volume.labels['atc.target'] === options.targetID &&
          volume.labels['atc.host'] === host &&
          daemon !== null &&
          volume.labels['atc.daemon'] === daemon
        );
      } catch {
        return false;
      }
    },

    findHostFact: (host) => {
      const id = hostIDs.get(host);

      return {
        name: buildHostNames(target, host).hostVolume,
        ...(id === undefined || id === '' ? {} : { id }),
      };
    },

    readHarnessFates: async (host, sessions) => {
      await requireOwnHost(host);

      try {
        const listed = await listHostContainers(host);

        const containers = new Map(
          listed.flatMap((container) => {
            const session = container.labels['atc.session'];

            return session === undefined || container.name.endsWith('-relay')
              ? []
              : [[session, container] as const];
          }),
        );

        return collectHarnessFates(sessions, containers);
      } catch (error) {
        throw toRefusal(error);
      }
    },

    spawnHarness: (spec) => {
      const built = planHarnessContainer(spec, 'harness');
      const names = built.names;
      const labels = built.labels;
      const mounts = built.mounts;
      const sidecarMounts = buildContainerMounts(buildMountSources(spec.host), 'sidecar');
      const home = getHome();
      const command = buildHomeRelativeCommand([spec.bin, ...spec.args], spec.cwd);
      const { [SESSION_ENV_NAMES.socket]: _socket, ...planned } = spec.env;

      const link = makeSidecarLink({
        engine,
        harness: names.harness,
        log,
        sidecar: {
          name: names.sidecar,
          image: target.image,
          labels,
          cmd: [`${target.guestDir}/bin/atc`, 'relay-mux', names.socket],
          env: {},
          tty: false,
          stdin: 'held',
          mounts: sidecarMounts,
        },
      });

      const relay = openStreamRelay(link, spec.onRelay ?? (() => {}), { reconnectDelaysMs, log });

      const harness = createDockerHarness({
        engine,
        relay,
        reconnectDelaysMs,
        log,
        container: {
          name: names.harness,
          image: target.image,
          labels,
          cmd: command.argv,
          env: {
            TERM: 'xterm-256color',
            LANG: 'C.UTF-8',
            ...planned,
            ...buildSessionEnv({ socket: names.socket, bridge: true, outbox: names.outbox }),
          },
          workingDir: command.cwd === '/' ? home : command.cwd,
          tty: true,
          stdin: 'held',
          mounts,
          size: { cols: spec.cols, rows: spec.rows },
        },
        onDone: () => {
          harnesses.delete(harness);
        },
      });

      harnesses.add(harness);

      return harness;
    },

    transferArchive: async (archive, directory, host) => {
      const result = await runOnHost(host, {
        argv: ['sh', '-c', UNPACK_ARCHIVE_SCRIPT, 'sh', directory],
        stdin: archive,
      });

      if (result.exitCode !== 0) {
        throw new Error(`tar exited ${result.exitCode} unpacking into ${directory}`);
      }
    },

    runCommand: async (spec) => {
      const command = buildHomeRelativeCommand(spec.argv, spec.cwd);

      const result = await runOnHost(spec.host, { argv: command.argv, cwd: command.cwd });

      const decoder = new TextDecoder();

      return {
        exitCode: result.exitCode,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },

    writeReadOnlyFile: (host, path, content) => {
      try {
        writeRecordFile(buildRecordsDir(host), path, content);
      } catch (error) {
        return Promise.reject(toRefusal(error));
      }

      return Promise.resolve(`${target.guestDir}/records/${path}`);
    },

    suspendHost: (host, isIdle) =>
      withHostTurn(host, async () => {
        if (isIdle !== undefined && !isIdle()) {
          throw buildHostRefusal(
            'busy',
            `host ${host} stays awake: a session runs there or is starting there`,
          );
        }

        await requireOwnHost(host);

        try {
          const containers = await listHostContainers(host);

          // a throwaway container of a command in flight ends on its own
          const running = containers.filter(
            (container) =>
              container.status === 'running' &&
              !container.name.startsWith(`${target.namePrefix}run-`),
          );

          // harnesses first, so a sidecar never waits on a frame a paused harness would send
          const ordered = [
            ...running.filter((container) => !container.name.endsWith('-relay')),
            ...running.filter((container) => container.name.endsWith('-relay')),
          ];

          for (const container of ordered) {
            await engine.pauseContainer(container.name);
          }
        } catch (error) {
          throw toRefusal(error);
        }
      }),

    destroyHost: (host) =>
      withHostTurn(host, async () => {
        await requireOwnHost(host);

        const names = buildHostNames(target, host);

        try {
          for (const container of await listHostContainers(host)) {
            await engine.removeContainer(container.name);
          }

          await engine.removeVolume(names.relayVolume);
          await engine.removeVolume(names.hostVolume);
        } catch (error) {
          throw toRefusal(error);
        }

        rmSync(buildRecordsDir(host), { recursive: true, force: true });

        hostIDs.delete(host);
      }),

    dispose: () => {
      for (const harness of harnesses) {
        harness.detach();
      }
    },
  };
}
