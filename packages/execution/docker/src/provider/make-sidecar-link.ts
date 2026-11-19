import type { RelayLink, RelayLinkConnection } from '@atc/plugin-api';
import type { ContainerSpec, DockerEngine } from '../engine/types';

interface SidecarLinkOptions {
  readonly engine: DockerEngine;

  // the sidecar container to create when the Engine holds none that runs
  readonly sidecar: ContainerSpec;

  // the harness container the sidecar serves
  readonly harness: string;
  readonly log: (line: string) => void;
}

// A relay link over the attach of the session's sidecar, whose main process is `atc relay-mux`.
// The Engine replays the sidecar's stdout from its first byte on each attach. A sidecar that
// stopped while its harness container runs, or a replace, gets a new container.
export function makeSidecarLink(options: SidecarLinkOptions): RelayLink {
  const engine = options.engine;
  const name = options.sidecar.name;

  const startSidecar = async (): Promise<void> => {
    await engine.removeContainer(name);
    await engine.createContainer(options.sidecar);
    await engine.startContainer(name);
  };

  const readEnd = async (): Promise<'dropped' | 'lost'> => {
    try {
      const sidecar = await engine.readContainer(name);

      if (sidecar?.status === 'running' || sidecar?.status === 'paused') {
        return 'dropped';
      }

      const harness = await engine.readContainer(options.harness);

      return harness?.status === 'running' || harness?.status === 'paused' ? 'dropped' : 'lost';
    } catch {
      return 'dropped';
    }
  };

  const readySidecar = async (replace: boolean): Promise<void> => {
    const existing = await engine.readContainer(name);

    if (!replace && existing?.status === 'running') {
      return;
    }

    if (!replace && existing?.status === 'paused') {
      await engine.unpauseContainer(name);

      return;
    }

    await startSidecar();
  };

  const reportEnd = async (listener: (end: 'dropped' | 'lost') => void): Promise<void> => {
    const end = await readEnd();

    options.log(`relay sidecar ${name} ended its attach (${end})`);

    listener(end);
  };

  return {
    open: async (openOptions) => {
      await readySidecar(openOptions?.replace === true);

      const attachment = await engine.attachContainer(name, { stdin: true, logs: true });

      let isDetached = false;

      const connection: RelayLinkConnection = {
        onData: (listener) => {
          attachment.onData((data, stream) => {
            if (stream === 'stdout') {
              listener(data);
            }
          });
        },
        onEnd: (listener) => {
          attachment.onEnd(() => {
            if (isDetached) {
              return;
            }

            void reportEnd(listener);
          });
        },
        write: (data) => attachment.write(data),
        detach: () => {
          isDetached = true;

          attachment.detach();
        },
      };

      return connection;
    },
  };
}
