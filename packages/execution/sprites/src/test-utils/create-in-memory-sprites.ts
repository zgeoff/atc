import { SpritesApiError } from '../port/sprites-api-error';
import type {
  ConnectorView,
  ExecConnection,
  ExecEnd,
  ExecRequest,
  ExecView,
  SpriteView,
  SpritesPort,
} from '../port/types';
import { waitOut } from '../port/wait-out';
import { BOOT_ID_PATH } from '../provider/boot-id-path';

interface RunAnswer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

type RunAnswerer = (request: ExecRequest, stdin: Uint8Array) => RunAnswer | Promise<RunAnswer>;

interface HeldFile {
  readonly content: Uint8Array;
  readonly mode: number;
}

interface HeldConnection {
  readonly dataListeners: ((data: Uint8Array, stream: 'stdout' | 'stderr') => void)[];
  readonly endListeners: ((end: ExecEnd) => void)[];
  isDone: boolean;
}

interface HeldExec {
  readonly id: string;
  readonly request: ExecRequest;
  readonly output: Uint8Array[];
  readonly input: Uint8Array[];
  readonly connections: Set<HeldConnection>;
}

interface HeldSprite {
  id: string;
  status: SpriteView['status'];
  bootID: string;
  readonly files: Map<string, HeldFile>;
  readonly execs: Map<string, HeldExec>;
}

export interface InMemorySprites extends SpritesPort {
  readonly requests: readonly { readonly sprite: string; readonly request: ExecRequest }[];
  readonly addConnector: (connector: ConnectorView) => void;
  readonly countReads: () => number;

  readonly answerRuns: (answer: RunAnswerer) => void;

  readonly refuseCreate: (status: number, message: string) => void;

  readonly refuseAttaches: () => void;

  readonly failAll: (status: number, message: string) => void;
  readonly findFile: (sprite: string, path: string) => HeldFile | null;
  readonly hasSprite: (name: string) => boolean;
  readonly countAttached: (sprite: string) => number;

  readonly listExecIDs: (sprite: string) => readonly string[];

  readonly findExecID: (sprite: string, commandPart: string) => string | null;
  readonly readInput: (sprite: string, execID: string) => string;
  readonly writeOutput: (sprite: string, execID: string, text: string) => void;

  readonly dropConnections: (sprite: string, execID: string) => void;
  readonly exitExec: (sprite: string, execID: string, exitCode: number) => void;

  readonly sleep: (sprite: string, status?: 'cold' | 'warm') => void;

  readonly changeBootID: (sprite: string) => void;
  readonly findBootID: (sprite: string) => string | null;
}

export function createInMemorySprites(): InMemorySprites {
  const sprites = new Map<string, HeldSprite>();

  const connectors: ConnectorView[] = [];
  const requests: { sprite: string; request: ExecRequest }[] = [];

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let nextSprite = 1;
  let nextExec = 100;
  let reads = 0;
  let createRefusal: { status: number; message: string } | null = null;
  let failure: { status: number; message: string } | null = null;
  let isAttachRefused = false;
  let answer: RunAnswerer = answerExited;

  const requireWorking = (): void => {
    if (failure !== null) {
      throw new SpritesApiError(failure.status, failure.message);
    }
  };

  const getSprite = (name: string): HeldSprite => {
    const sprite = sprites.get(name);

    if (sprite === undefined) {
      throw new SpritesApiError(404, `sprite ${name} does not exist`);
    }

    return sprite;
  };

  const finishExec = (sprite: HeldSprite, exec: HeldExec, exitCode: number): void => {
    sprite.execs.delete(exec.id);

    for (const connection of exec.connections) {
      closeConnection(connection, { kind: 'exit', exitCode });
    }

    exec.connections.clear();
  };

  const completeRun = async (sprite: HeldSprite, exec: HeldExec): Promise<void> => {
    const stdin = new Uint8Array(exec.input.reduce((sum, chunk) => sum + chunk.length, 0));

    let offset = 0;

    for (const chunk of exec.input) {
      stdin.set(chunk, offset);

      offset += chunk.length;
    }

    const isBootRead = exec.request.argv.join(' ') === `cat ${BOOT_ID_PATH}`;

    const result = isBootRead
      ? { stdout: `${sprite.bootID}\n`, exitCode: 0 }
      : await answer(exec.request, stdin);

    if (result.stdout !== undefined) {
      deliverOutput(exec, encoder.encode(result.stdout), 'stdout');
    }

    if (result.stderr !== undefined) {
      deliverOutput(exec, encoder.encode(result.stderr), 'stderr');
    }

    finishExec(sprite, exec, result.exitCode);
  };

  const attachConnection = (
    sprite: HeldSprite,
    exec: HeldExec | null,
    request: ExecRequest,
  ): ExecConnection => {
    const connection: HeldConnection = { dataListeners: [], endListeners: [], isDone: false };
    const execID = Promise.withResolvers<string>();

    void waitOut(execID.promise);
    const isRun = !request.tty && request.outlivesClients !== true;

    if (exec === null || isAttachRefused) {
      setTimeout(() => {
        execID.reject(new SpritesApiError(404, `exec ${request.execID ?? ''} does not exist`));

        closeConnection(connection, { kind: 'dropped' });
      }, 0);
    } else {
      sprite.status = 'running';

      exec.connections.add(connection);
      execID.resolve(exec.id);

      if (request.execID !== undefined) {
        setTimeout(() => {
          for (const chunk of exec.output) {
            for (const listener of connection.dataListeners) {
              listener(chunk, 'stdout');
            }
          }
        }, 0);
      }
    }

    return {
      execID: execID.promise,
      onData: (listener) => {
        connection.dataListeners.push(listener);
      },
      onEnd: (listener) => {
        connection.endListeners.push(listener);
      },
      write: (data) => {
        exec?.input.push(data);

        return Promise.resolve();
      },
      endInput: () => {
        if (exec !== null && isRun && request.execID === undefined) {
          void completeRun(sprite, exec);
        }
      },
      resize: () => {},
      signal: (signal) => {
        if (exec !== null) {
          const exitCode = signal === 'SIGKILL' ? 137 : 143;

          finishExec(sprite, exec, exitCode);
        }
      },
      detach: () => {
        connection.isDone = true;
        exec?.connections.delete(connection);
      },
    };
  };

  return {
    get requests() {
      return requests;
    },

    addConnector: (connector) => {
      connectors.push(connector);
    },
    countReads: () => reads,
    answerRuns: (next) => {
      answer = next;
    },
    refuseCreate: (status, message) => {
      createRefusal = { status, message };
    },
    refuseAttaches: () => {
      isAttachRefused = true;
    },
    failAll: (status, message) => {
      failure = { status, message };
    },

    readSprite: (name) => {
      requireWorking();

      const sprite = sprites.get(name);
      const view = sprite === undefined ? null : readView(name, sprite);

      return Promise.resolve(view);
    },

    createSprite: (name) => {
      requireWorking();

      if (createRefusal !== null) {
        const refusal = createRefusal;

        createRefusal = null;

        return Promise.reject(new SpritesApiError(refusal.status, refusal.message));
      }

      if (sprites.has(name)) {
        return Promise.reject(new SpritesApiError(409, `sprite ${name} already exists`));
      }

      const sprite: HeldSprite = {
        id: `sprite-${nextSprite}`,
        status: 'running',
        bootID: `boot-${nextSprite}`,
        files: new Map(),
        execs: new Map(),
      };

      nextSprite += 1;

      sprites.set(name, sprite);

      return Promise.resolve(readView(name, sprite));
    },

    removeSprite: (name) => {
      requireWorking();

      const sprite = sprites.get(name);

      if (sprite !== undefined) {
        for (const exec of sprite.execs.values()) {
          finishExec(sprite, exec, 137);
        }

        sprites.delete(name);
      }

      return Promise.resolve();
    },

    listExecs: (name) => {
      requireWorking();

      const sprite = getSprite(name);

      return Promise.resolve(
        [...sprite.execs.values()].map((exec): ExecView => ({
          id: exec.id,
          command: exec.request.argv.join(' '),
          tty: exec.request.tty,
        })),
      );
    },

    openExec: (name, request) => {
      requireWorking();

      const sprite = getSprite(name);

      requests.push({ sprite: name, request });

      if (request.execID !== undefined) {
        return attachConnection(sprite, sprite.execs.get(request.execID) ?? null, request);
      }

      nextExec += 1;

      const exec: HeldExec = {
        id: String(nextExec),
        request,
        output: [],
        input: [],
        connections: new Set(),
      };

      sprite.execs.set(exec.id, exec);

      return attachConnection(sprite, exec, request);
    },

    readConnectors: () => {
      requireWorking();

      reads += 1;

      return Promise.resolve([...connectors]);
    },

    readFile: (name, path) => {
      requireWorking();

      const sprite = getSprite(name);

      sprite.status = 'running';

      // The real file endpoint sends no bytes for a /proc file, whose size reads as 0.
      if (path.startsWith('/proc/')) {
        return Promise.resolve(new Uint8Array());
      }

      return Promise.resolve(sprite.files.get(path)?.content ?? null);
    },

    writeFile: (name, path, content, mode) => {
      requireWorking();
      getSprite(name).files.set(path, { content, mode });

      return Promise.resolve();
    },

    findFile: (name, path) => sprites.get(name)?.files.get(path) ?? null,
    hasSprite: (name) => sprites.has(name),
    countAttached: (name) =>
      [...(sprites.get(name)?.execs.values() ?? [])].reduce(
        (sum, exec) => sum + exec.connections.size,
        0,
      ),
    listExecIDs: (name) => [...getSprite(name).execs.keys()],

    findExecID: (name, commandPart) => {
      const execs = sprites.get(name)?.execs.values() ?? [];

      for (const exec of execs) {
        if (exec.request.argv.join(' ').includes(commandPart)) {
          return exec.id;
        }
      }

      return null;
    },

    readInput: (name, execID) =>
      decoder.decode(
        Buffer.concat(
          getSprite(name)
            .execs.get(execID)
            ?.input.map((chunk) => chunk) ?? [],
        ),
      ),

    writeOutput: (name, execID, text) => {
      const exec = getSprite(name).execs.get(execID);

      if (exec !== undefined) {
        deliverOutput(exec, encoder.encode(text), 'stdout');
      }
    },

    dropConnections: (name, execID) => {
      const exec = getSprite(name).execs.get(execID);

      for (const connection of exec?.connections ?? []) {
        exec?.connections.delete(connection);
        closeConnection(connection, { kind: 'dropped' });
      }
    },

    exitExec: (name, execID, exitCode) => {
      const sprite = getSprite(name);
      const exec = sprite.execs.get(execID);

      if (exec !== undefined) {
        finishExec(sprite, exec, exitCode);
      }
    },

    sleep: (name, status = 'cold') => {
      const sprite = getSprite(name);

      for (const exec of sprite.execs.values()) {
        for (const connection of exec.connections) {
          exec.connections.delete(connection);

          closeConnection(connection, { kind: 'dropped' });
        }
      }

      sprite.status = status;
    },

    changeBootID: (name) => {
      const sprite = getSprite(name);

      for (const exec of sprite.execs.values()) {
        for (const connection of exec.connections) {
          exec.connections.delete(connection);

          closeConnection(connection, { kind: 'dropped' });
        }

        sprite.execs.delete(exec.id);
      }

      sprite.bootID = `boot-${nextSprite}-${nextExec}`;
      nextExec += 1;
      sprite.status = 'cold';
    },

    findBootID: (name) => sprites.get(name)?.bootID ?? null,
  };
}

function answerExited(): RunAnswer {
  return { exitCode: 0 };
}

function closeConnection(connection: HeldConnection, end: ExecEnd): void {
  if (connection.isDone) {
    return;
  }

  connection.isDone = true;

  for (const listener of connection.endListeners) {
    listener(end);
  }
}

function deliverOutput(exec: HeldExec, data: Uint8Array, stream: 'stdout' | 'stderr'): void {
  if (stream === 'stdout') {
    exec.output.push(data);
  }

  for (const connection of exec.connections) {
    for (const listener of connection.dataListeners) {
      listener(data, stream);
    }
  }
}

function readView(name: string, sprite: HeldSprite): SpriteView {
  const isAttached = [...sprite.execs.values()].some((exec) => exec.connections.size > 0);

  if (isAttached) {
    return { id: sprite.id, name, status: 'running' };
  }

  return { id: sprite.id, name, status: sprite.status === 'running' ? 'warm' : sprite.status };
}
