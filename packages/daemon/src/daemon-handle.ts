export interface DaemonHandle {
  readonly stop: () => Promise<void>;

  readonly [Symbol.asyncDispose]: () => Promise<void>;

  readonly countClients: () => number;

  readonly countEventWaiters: () => number;

  readonly listenPort: number | null;

  readonly refreshTokens: () => void;
}
