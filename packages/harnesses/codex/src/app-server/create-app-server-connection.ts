import { z } from 'zod';
import { AppServerError } from './app-server-error';

export interface AppServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface AppServerConnection {
  onNotification: (notification: AppServerNotification) => void;
  onRequest: (request: AppServerRequest) => void;
  onClose: () => void;
  readonly isOpen: boolean;
  sendRequest: (method: string, params: unknown) => Promise<unknown>;

  // Answers one server request; an answer after the connection closed goes
  // nowhere.
  readonly sendResult: (id: number | string, result: unknown) => void;
  dispose: () => void;
}

const LINE_SCHEMA = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

interface Waiting {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Readonly<AppServerError>) => void;
}

// `ws+unix://<path>` reaches a unix socket
export async function createAppServerConnection(url: string): Promise<AppServerConnection> {
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener(
      'open',
      () => {
        resolve();
      },
      { once: true },
    );

    ws.addEventListener(
      'error',
      () => {
        reject(new AppServerError(-1, `no App Server answered at ${url}`));
      },
      { once: true },
    );
  });

  const waiting = new Map<number, Waiting>();

  let nextID = 1;
  let closed = false;

  const self: AppServerConnection = {
    onNotification: () => {},
    onRequest: () => {},
    onClose: () => {},

    get isOpen() {
      return !closed;
    },

    sendRequest: (method, params) => {
      if (closed) {
        return Promise.reject(new AppServerError(-1, 'the connection is closed'));
      }

      const id = nextID;

      nextID += 1;

      const answered = new Promise<unknown>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });

      ws.send(JSON.stringify({ id, method, params }));

      return answered;
    },

    sendResult: (id, result) => {
      if (!closed) {
        ws.send(JSON.stringify({ id, result }));
      }
    },

    dispose: () => {
      ws.close();
    },
  };

  const applyLine = (line: string): void => {
    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      return;
    }

    const parsed = LINE_SCHEMA.safeParse(value);

    if (!parsed.success) {
      return;
    }

    const message = parsed.data;

    if (message.method !== undefined && message.id !== undefined) {
      self.onRequest({ id: message.id, method: message.method, params: message.params });

      return;
    }

    if (message.method !== undefined) {
      self.onNotification({ method: message.method, params: message.params });

      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const entry = waiting.get(message.id);

    waiting.delete(message.id);

    if (message.error === undefined) {
      entry?.resolve(message.result);
    } else {
      entry?.reject(new AppServerError(message.error.code, message.error.message));
    }
  };

  ws.addEventListener('message', (messageEvent) => {
    applyLine(String(messageEvent.data));
  });

  ws.addEventListener('close', () => {
    closed = true;

    for (const entry of waiting.values()) {
      entry.reject(new AppServerError(-1, 'the connection closed'));
    }

    waiting.clear();
    self.onClose();
  });

  return self;
}
