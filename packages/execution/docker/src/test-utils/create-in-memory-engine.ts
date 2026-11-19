import { EngineError } from '../engine/engine-error';
import { EngineUnreachableError } from '../engine/engine-unreachable-error';
import type {
  ContainerAttachment,
  ContainerInfo,
  ContainerSpec,
  ContainerStatus,
  DockerEngine,
  EngineInfo,
  Labels,
  StreamName,
  VolumeInfo,
  VolumeSpec,
} from '../engine/types';

export interface RunResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

interface FakeAttachment {
  readonly dataListeners: ((data: Uint8Array, stream: StreamName) => void)[];
  readonly endListeners: (() => void)[];
  isOpen: boolean;
  isWriteClosed: boolean;
}

interface FakeContainer {
  readonly spec: ContainerSpec;
  status: ContainerStatus;
  exitCode: number;
  readonly log: { data: Uint8Array; stream: StreamName }[];
  readonly input: Uint8Array[];
  readonly attachments: Set<FakeAttachment>;
  readonly sizes: { cols: number; rows: number }[];
}

export interface InMemoryEngine extends DockerEngine {
  readonly addImage: (reference: string) => void;
  readonly removeImage: (reference: string) => void;
  readonly setInfo: (info: EngineInfo) => void;
  readonly setUnreachable: (isUnreachable: boolean) => void;

  readonly answerRuns: (answer: (spec: ContainerSpec, stdin: Uint8Array) => RunResult) => void;

  readonly writeOutput: (name: string, text: string) => void;
  readonly exitContainer: (name: string, exitCode: number) => void;
  readonly dropAttachments: (name: string) => void;

  readonly restart: () => void;
  readonly seedContainer: (spec: ContainerSpec, status: ContainerStatus, exitCode?: number) => void;

  readonly collectContainers: () => readonly ContainerSpec[];

  readonly collectCreated: () => readonly ContainerSpec[];
  readonly collectVolumes: () => readonly VolumeSpec[];
  readonly readInput: (name: string) => string;
  readonly readSizes: (name: string) => readonly { cols: number; rows: number }[];
  readonly countAttachments: (name: string) => number;
}

const encoder = new TextEncoder();

export function createInMemoryEngine(): InMemoryEngine {
  const images = new Set<string>();
  const volumes = new Map<string, VolumeSpec>();
  const containers = new Map<string, FakeContainer>();

  const created: ContainerSpec[] = [];
  let info: EngineInfo = { osType: 'linux', architecture: 'x86_64' };
  let isUnreachable = false;

  const runner: { answer: (spec: ContainerSpec, stdin: Uint8Array) => RunResult } = {
    answer: answerWithSuccess,
  };

  const guard = (): void => {
    if (isUnreachable) {
      throw new EngineUnreachableError('/var/run/docker.sock');
    }
  };

  const requireContainer = (name: string): FakeContainer => {
    const container = containers.get(name);

    if (container === undefined) {
      throw new EngineError(404, `no such container: ${name}`);
    }

    return container;
  };

  const deliver = (container: FakeContainer, data: Uint8Array, stream: StreamName): void => {
    container.log.push({ data, stream });

    for (const attachment of container.attachments) {
      for (const listener of attachment.dataListeners) {
        listener(data, stream);
      }
    }
  };

  const endAttachments = (container: FakeContainer): void => {
    const ending = [...container.attachments];

    container.attachments.clear();

    for (const attachment of ending) {
      attachment.isOpen = false;

      for (const listener of attachment.endListeners) {
        listener();
      }
    }
  };

  const stop = (container: FakeContainer, exitCode: number): void => {
    container.status = 'exited';
    container.exitCode = exitCode;

    endAttachments(container);
  };

  const finishRun = (container: FakeContainer, stdin: Uint8Array): void => {
    const result = runner.answer(container.spec, stdin);

    if (result.stdout !== undefined) {
      deliver(container, encoder.encode(result.stdout), 'stdout');
    }

    if (result.stderr !== undefined) {
      deliver(container, encoder.encode(result.stderr), 'stderr');
    }

    stop(container, result.exitCode);
  };

  const toInfo = (name: string, container: FakeContainer): ContainerInfo => ({
    name,
    labels: container.spec.labels,
    status: container.status,
    exitCode: container.exitCode,
  });

  const buildAttachment = (container: FakeContainer, withLogs: boolean): ContainerAttachment => {
    const fake: FakeAttachment = {
      dataListeners: [],
      endListeners: [],
      isOpen: true,
      isWriteClosed: false,
    };

    container.attachments.add(fake);

    if (withLogs) {
      const replayed = [...container.log];

      setTimeout(() => {
        for (const entry of replayed) {
          for (const listener of fake.dataListeners) {
            listener(entry.data, entry.stream);
          }
        }

        if (container.status === 'exited' && fake.isOpen) {
          container.attachments.delete(fake);

          fake.isOpen = false;

          for (const listener of fake.endListeners) {
            listener();
          }
        }
      }, 0);
    }

    return {
      onData: (listener) => {
        fake.dataListeners.push(listener);
      },
      onEnd: (listener) => {
        fake.endListeners.push(listener);
      },
      write: (data) => {
        if (!fake.isOpen) {
          return Promise.reject(new Error('the attach ended'));
        }

        container.input.push(data);

        return Promise.resolve();
      },
      closeWrite: () => {
        fake.isWriteClosed = true;

        if (isRunToCompletion(container.spec) && container.status === 'running') {
          finishRun(container, Buffer.concat(container.input));
        }
      },
      detach: () => {
        fake.isOpen = false;

        container.attachments.delete(fake);
      },
    };
  };

  return {
    addImage: (reference) => {
      images.add(reference);
    },
    removeImage: (reference) => {
      images.delete(reference);
    },
    setInfo: (next) => {
      info = next;
    },
    setUnreachable: (next) => {
      isUnreachable = next;
    },
    answerRuns: (next) => {
      runner.answer = next;
    },
    writeOutput: (name, text) => {
      deliver(requireContainer(name), encoder.encode(text), 'stdout');
    },
    exitContainer: (name, exitCode) => {
      stop(requireContainer(name), exitCode);
    },
    dropAttachments: (name) => {
      endAttachments(requireContainer(name));
    },
    restart: () => {
      for (const container of containers.values()) {
        if (container.status === 'running' || container.status === 'paused') {
          stop(container, 137);
        }
      }
    },
    seedContainer: (spec, status, exitCode = 0) => {
      containers.set(spec.name, {
        spec,
        status,
        exitCode,
        log: [],
        input: [],
        attachments: new Set(),
        sizes: [],
      });
    },
    collectContainers: () => [...containers.values()].map((container) => container.spec),
    collectCreated: () => [...created],
    collectVolumes: () => [...volumes.values()],
    readInput: (name) => new TextDecoder().decode(Buffer.concat(requireContainer(name).input)),
    readSizes: (name) => requireContainer(name).sizes,
    countAttachments: (name) => requireContainer(name).attachments.size,

    readInfo: () => {
      guard();

      return Promise.resolve(info);
    },
    readImage: (reference) => {
      guard();

      const image = images.has(reference) ? { id: `sha256:${reference}` } : null;

      return Promise.resolve(image);
    },
    readVolume: (name) => {
      guard();

      const volume = volumes.get(name);
      const found = volume === undefined ? null : { name, labels: volume.labels };

      return Promise.resolve(found);
    },
    listVolumes: (labels) => {
      guard();

      const found: VolumeInfo[] = [...volumes.values()].filter((volume) =>
        hasLabels(volume.labels, labels),
      );

      return Promise.resolve(found);
    },
    createVolume: (spec) => {
      guard();

      if (volumes.has(spec.name)) {
        return Promise.reject(new EngineError(409, `volume ${spec.name} exists`));
      }

      volumes.set(spec.name, spec);

      return Promise.resolve();
    },
    removeVolume: (name) => {
      guard();

      volumes.delete(name);

      return Promise.resolve();
    },
    readContainer: (name) => {
      guard();

      const container = containers.get(name);
      const found = container === undefined ? null : toInfo(name, container);

      return Promise.resolve(found);
    },
    listContainers: (labels) => {
      guard();

      const found = [...containers.entries()]
        .filter(([, container]) => hasLabels(container.spec.labels, labels))
        .map(([name, container]) => toInfo(name, container));

      return Promise.resolve(found);
    },
    createContainer: (spec) => {
      guard();

      if (containers.has(spec.name)) {
        return Promise.reject(new EngineError(409, `container ${spec.name} exists`));
      }

      created.push(spec);

      containers.set(spec.name, {
        spec,
        status: 'created',
        exitCode: 0,
        log: [],
        input: [],
        attachments: new Set(),
        sizes: buildInitialSizes(spec),
      });

      return Promise.resolve();
    },
    startContainer: (name) => {
      guard();

      const container = requireContainer(name);

      container.status = 'running';

      if (isRunToCompletion(container.spec) && container.spec.stdin === 'none') {
        setTimeout(() => {
          finishRun(container, new Uint8Array(0));
        }, 0);
      }

      return Promise.resolve();
    },
    pauseContainer: (name) => {
      guard();

      const container = requireContainer(name);

      if (container.status !== 'running') {
        return Promise.reject(new EngineError(409, `container ${name} is not running`));
      }

      container.status = 'paused';

      return Promise.resolve();
    },
    unpauseContainer: (name) => {
      guard();

      const container = requireContainer(name);

      if (container.status !== 'paused') {
        return Promise.reject(new EngineError(409, `container ${name} is not paused`));
      }

      container.status = 'running';

      return Promise.resolve();
    },
    killContainer: (name, signal) => {
      guard();

      const exitCode = signal === 'SIGKILL' ? 137 : 143;

      stop(requireContainer(name), exitCode);

      return Promise.resolve();
    },
    removeContainer: (name) => {
      guard();

      const container = containers.get(name);

      if (container !== undefined) {
        endAttachments(container);

        containers.delete(name);
      }

      return Promise.resolve();
    },
    resizeContainer: (name, cols, rows) => {
      guard();
      requireContainer(name).sizes.push({ cols, rows });

      return Promise.resolve();
    },
    attachContainer: (name, options) => {
      guard();

      return Promise.resolve(buildAttachment(requireContainer(name), options.logs));
    },
  };
}

function answerWithSuccess(): RunResult {
  return { exitCode: 0 };
}

function isRunToCompletion(spec: ContainerSpec): boolean {
  return !spec.tty && spec.stdin !== 'held';
}

function hasLabels(actual: Labels, wanted: Labels): boolean {
  return Object.entries(wanted).every(([key, value]) => actual[key] === value);
}

function buildInitialSizes(spec: ContainerSpec): { cols: number; rows: number }[] {
  return spec.size === undefined ? [] : [spec.size];
}
