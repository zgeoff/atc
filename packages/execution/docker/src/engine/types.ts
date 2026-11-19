export type Labels = Readonly<Record<string, string>>;

export interface EngineInfo {
  readonly osType: string;

  // the Engine's own word for its architecture, such as `x86_64` or `aarch64`
  readonly architecture: string;
}

interface ImageInfo {
  readonly id: string;
}

export interface VolumeInfo {
  readonly name: string;
  readonly labels: Labels;
}

export interface VolumeSpec {
  readonly name: string;
  readonly labels: Labels;

  // a volume held in memory that any user may write, with its sticky bit set
  readonly shared?: boolean;
}

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead';

export interface ContainerInfo {
  readonly name: string;
  readonly labels: Labels;
  readonly status: ContainerStatus;
  readonly exitCode: number;
}

export type Mount =
  | {
      readonly kind: 'volume';
      readonly source: string;
      readonly target: string;
      readonly readOnly: boolean;
    }
  | {
      readonly kind: 'bind';
      readonly source: string;
      readonly target: string;
      readonly readOnly: boolean;
    };

// held: the container's stdin stays open when an attach to it ends. once: it closes with the
// attach's write side.
type StdinMode = 'none' | 'held' | 'once';

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly labels: Labels;
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly workingDir?: string;
  readonly tty: boolean;
  readonly stdin: StdinMode;
  readonly mounts: readonly Mount[];
  readonly size?: { readonly cols: number; readonly rows: number };
}

export type StreamName = 'stdout' | 'stderr';

interface AttachOptions {
  readonly stdin: boolean;

  // replays what the container has written since it started before it streams the rest
  readonly logs: boolean;
}

export interface ContainerAttachment {
  readonly onData: (listener: (data: Uint8Array, stream: StreamName) => void) => void;

  // the attach ended, whether the container exited, the Engine dropped it or detach ran
  readonly onEnd: (listener: () => void) => void;
  readonly write: (data: Uint8Array) => Promise<void>;

  // ends the attach's write side, which ends the container's stdin when its mode is once
  readonly closeWrite: () => void;

  // lets go of the attach and leaves the container as it is
  readonly detach: () => void;
}

// The calls the provider makes of a Docker Engine, and no others.
export interface DockerEngine {
  readonly readInfo: () => Promise<EngineInfo>;
  readonly readImage: (reference: string) => Promise<ImageInfo | null>;
  readonly readVolume: (name: string) => Promise<VolumeInfo | null>;
  readonly listVolumes: (labels: Labels) => Promise<readonly VolumeInfo[]>;
  readonly createVolume: (spec: VolumeSpec) => Promise<void>;
  readonly removeVolume: (name: string) => Promise<void>;
  readonly readContainer: (name: string) => Promise<ContainerInfo | null>;
  readonly listContainers: (labels: Labels) => Promise<readonly ContainerInfo[]>;
  readonly createContainer: (spec: ContainerSpec) => Promise<void>;
  readonly startContainer: (name: string) => Promise<void>;
  readonly pauseContainer: (name: string) => Promise<void>;
  readonly unpauseContainer: (name: string) => Promise<void>;
  readonly killContainer: (name: string, signal: 'SIGTERM' | 'SIGKILL') => Promise<void>;

  // removes the container, running or not
  readonly removeContainer: (name: string) => Promise<void>;
  readonly resizeContainer: (name: string, cols: number, rows: number) => Promise<void>;
  readonly attachContainer: (name: string, options: AttachOptions) => Promise<ContainerAttachment>;
}
