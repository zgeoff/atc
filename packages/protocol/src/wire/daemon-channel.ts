import type { DaemonConnection } from '@atcx/client/connection';

export interface HelloOptions {
  readonly token?: string;

  readonly session?: string | undefined;

  readonly principal?: string;

  readonly viewer?: string;
}

export interface DaemonChannel {
  onClose: () => void;

  // the connection the hello opened; it throws until the hello is accepted
  readonly connection: DaemonConnection;
  readonly sendHello: (
    build: string,
    options?: HelloOptions,
  ) => Promise<Readonly<Record<string, unknown>>>;

  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}
