import { z } from 'zod';
import { EngineError } from './engine-error';
import { EngineUnreachableError } from './engine-unreachable-error';
import { openHijackedStream } from './open-hijacked-stream';
import type {
  ContainerInfo,
  ContainerSpec,
  ContainerStatus,
  DockerEngine,
  Labels,
  VolumeInfo,
  VolumeSpec,
} from './types';

const REQUEST_TIMEOUT_MS = 30_000;
const INFO_SCHEMA = z.object({ OSType: z.string(), Architecture: z.string() });
const IMAGE_SCHEMA = z.object({ Id: z.string() });
const LABELS_SCHEMA = z.record(z.string(), z.string()).nullish();
const VOLUME_SCHEMA = z.object({ Name: z.string(), Labels: LABELS_SCHEMA });
const VOLUME_LIST_SCHEMA = z.object({ Volumes: z.array(VOLUME_SCHEMA).nullish() });

const CONTAINER_SCHEMA = z.object({
  Name: z.string(),
  Config: z.object({ Labels: LABELS_SCHEMA }),
  State: z.object({
    Status: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
    ExitCode: z.number(),
  }),
});

const NAMES_SCHEMA = z.array(z.string());
const CONTAINER_LIST_SCHEMA = z.array(z.object({ Names: NAMES_SCHEMA }));

export function createEngineClient(socketPath: string): DockerEngine {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    accepted: readonly number[] = [],
  ): Promise<Response> => {
    let response: Response;

    try {
      response = await fetch(`http://docker${path}`, {
        unix: socketPath,
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new EngineUnreachableError(socketPath, { cause: error });
    }

    if (response.ok || accepted.includes(response.status)) {
      return response;
    }

    const text = await response.text();

    throw new EngineError(
      response.status,
      `${method} ${path} answered ${response.status}: ${text}`,
    );
  };

  const readJSON = async <T>(path: string, schema: z.ZodType<T>): Promise<T | null> => {
    const response = await call('GET', path, undefined, [404]);

    if (response.status === 404) {
      return null;
    }

    const body: unknown = await response.json();

    return schema.parse(body);
  };

  const readContainer = async (name: string): Promise<ContainerInfo | null> => {
    const container = await readJSON(
      `/containers/${encodeURIComponent(name)}/json`,
      CONTAINER_SCHEMA,
    );

    return container === null
      ? null
      : {
          name: toContainerName(container.Name),
          labels: container.Config.Labels ?? {},
          status: container.State.Status satisfies ContainerStatus,
          exitCode: container.State.ExitCode,
        };
  };

  const post = async (name: string, action: string, query = ''): Promise<void> => {
    await call(
      'POST',
      `/containers/${encodeURIComponent(name)}/${action}${query}`,
      undefined,
      [304],
    );
  };

  return {
    readInfo: async () => {
      const response = await call('GET', '/info');
      const body: unknown = await response.json();

      const info = INFO_SCHEMA.parse(body);

      return { osType: info.OSType, architecture: info.Architecture };
    },

    readImage: async (reference) => {
      const image = await readJSON(`/images/${reference}/json`, IMAGE_SCHEMA);

      return image === null ? null : { id: image.Id };
    },

    readVolume: async (name) => {
      const volume = await readJSON(`/volumes/${encodeURIComponent(name)}`, VOLUME_SCHEMA);

      return volume === null ? null : toVolumeInfo(volume);
    },

    listVolumes: async (labels) => {
      const response = await call('GET', `/volumes?filters=${buildFilters(labels)}`);
      const body: unknown = await response.json();

      const list = VOLUME_LIST_SCHEMA.parse(body);

      return (list.Volumes ?? []).map((volume) => toVolumeInfo(volume));
    },

    createVolume: async (spec: VolumeSpec) => {
      await call('POST', '/volumes/create', {
        Name: spec.name,
        Labels: spec.labels,
        ...(spec.shared === true ? { Driver: 'local', DriverOpts: buildTmpfsOptions() } : {}),
      });
    },

    removeVolume: async (name) => {
      await call('DELETE', `/volumes/${encodeURIComponent(name)}`, undefined, [404]);
    },

    readContainer,

    listContainers: async (labels) => {
      const response = await call('GET', `/containers/json?all=1&filters=${buildFilters(labels)}`);
      const body: unknown = await response.json();

      const listed = CONTAINER_LIST_SCHEMA.parse(body);

      const names = listed
        .flatMap((entry) => entry.Names.slice(0, 1))
        .map((name) => toContainerName(name));

      const found = await Promise.all(names.map((name) => readContainer(name)));

      return found.filter((container) => container !== null);
    },

    createContainer: async (spec: ContainerSpec) => {
      await call('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, {
        Image: spec.image,
        Entrypoint: [''],
        Cmd: spec.cmd,
        Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
        Labels: spec.labels,
        Tty: spec.tty,
        OpenStdin: spec.stdin !== 'none',
        StdinOnce: spec.stdin === 'once',
        AttachStdin: spec.stdin !== 'none',
        AttachStdout: true,
        AttachStderr: true,
        ...(spec.workingDir === undefined ? {} : { WorkingDir: spec.workingDir }),
        HostConfig: {
          Init: true,
          Mounts: spec.mounts.map((mount) => ({
            Type: mount.kind,
            Source: mount.source,
            Target: mount.target,
            ReadOnly: mount.readOnly,
          })),
          ...(spec.size === undefined ? {} : { ConsoleSize: [spec.size.rows, spec.size.cols] }),
        },
      });
    },

    startContainer: (name) => post(name, 'start'),
    pauseContainer: (name) => post(name, 'pause'),
    unpauseContainer: (name) => post(name, 'unpause'),
    killContainer: (name, signal) => post(name, 'kill', `?signal=${signal}`),

    removeContainer: async (name) => {
      await call('DELETE', `/containers/${encodeURIComponent(name)}?force=1`, undefined, [404]);
    },

    resizeContainer: (name, cols, rows) => post(name, 'resize', `?h=${rows}&w=${cols}`),

    attachContainer: (name, options) =>
      openHijackedStream(
        socketPath,
        `/containers/${encodeURIComponent(name)}/attach?stream=1&stdin=${options.stdin ? 1 : 0}&stdout=1&stderr=1&logs=${options.logs ? 1 : 0}`,
      ),
  };
}

function toContainerName(name: string): string {
  return name.replace(/^\//u, '');
}

function toVolumeInfo(volume: z.infer<typeof VOLUME_SCHEMA>): VolumeInfo {
  return { name: volume.Name, labels: volume.Labels ?? {} };
}

function buildFilters(labels: Labels): string {
  const label = Object.entries(labels).map(([name, value]) => `${name}=${value}`);

  return encodeURIComponent(JSON.stringify({ label }));
}

// Docker's local volume driver reads mount options only from the key `o`; a longer key name does
// not work.
function buildTmpfsOptions(): Record<string, string> {
  return Object.fromEntries([
    ['type', 'tmpfs'],
    ['device', 'tmpfs'],
    ['o', 'mode=1777'],
  ]);
}
