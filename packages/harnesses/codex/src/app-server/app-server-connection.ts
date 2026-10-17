import { z } from 'zod';
import { AppServerError } from './app-server-error';

/**
 * A request the server sent the client, which waits for the client's answer.
 */
export interface AppServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: unknown;
}

/**
 * A notification the server sent, which takes no answer.
 */
export interface AppServerNotification {
  readonly method: string;
  readonly params: unknown;
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

/**
 * One client connection to a Codex App Server: JSON-RPC 2.0 messages over a
 * WebSocket, as `codex app-server --listen` serves them. A request resolves
 * with the server's result or rejects with an `AppServerError`, and every
 * request still waiting when the connection closes rejects, so no caller
 * waits on a closed connection. Notifications and server requests reach
 * the listeners set on the connection, in the order they arrived.
 */
export class AppServerConnection {
  onNotification: (notification: AppServerNotification) => void = () => {};

  onRequest: (request: AppServerRequest) => void = () => {};

  onClose: () => void = () => {};

  private readonly ws: WebSocket;

  private readonly waiting = new Map<number, Waiting>();

  private nextID = 1;

  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;

    ws.addEventListener('message', (e) => {
      this.applyLine(String(e.data));
    });

    ws.addEventListener('close', () => {
      this.closed = true;

      for (const entry of this.waiting.values()) {
        entry.reject(new AppServerError(-1, 'the connection closed'));
      }

      this.waiting.clear();
      this.onClose();
    });
  }

  /**
   * Opens a connection to the server at the URL, `ws+unix://<path>` for a
   * Unix socket, and resolves once it is open.
   */
  static async open(url: string): Promise<AppServerConnection> {
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

    return new AppServerConnection(ws);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AppServerError(-1, 'the connection is closed'));
    }

    const id = this.nextID;

    this.nextID += 1;

    const answered = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify({ id, method, params }));

    return answered;
  }

  // Answers one server request; an answer after the connection closed goes
  // nowhere.
  sendResult(id: number | string, result: unknown): void {
    if (!this.closed) {
      this.ws.send(JSON.stringify({ id, result }));
    }
  }

  dispose(): void {
    this.ws.close();
  }

  private applyLine(line: string): void {
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

    const msg = parsed.data;

    if (msg.method !== undefined && msg.id !== undefined) {
      this.onRequest({ id: msg.id, method: msg.method, params: msg.params });

      return;
    }

    if (msg.method !== undefined) {
      this.onNotification({ method: msg.method, params: msg.params });

      return;
    }

    if (typeof msg.id !== 'number') {
      return;
    }

    const entry = this.waiting.get(msg.id);

    this.waiting.delete(msg.id);

    if (msg.error === undefined) {
      entry?.resolve(msg.result);
    } else {
      entry?.reject(new AppServerError(msg.error.code, msg.error.message));
    }
  }
}
