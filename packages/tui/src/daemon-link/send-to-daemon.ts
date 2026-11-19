import { formatError } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import type { DaemonName } from '../fleet/session-key';
import { formatLinkState } from './daemon-link-state';
import type { DaemonLinkState } from './daemon-link-state';
import { DaemonUnavailableError } from './daemon-unavailable-error';

export interface RequestLinks {
  readonly clientFor: (daemon: DaemonName) => Pick<DaemonClient, 'sendRequest'> | null;
  readonly stateOf: (daemon: DaemonName) => DaemonLinkState;
}

export function sendToDaemon(
  links: RequestLinks,
  daemon: DaemonName,
  method: string,
  params?: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const client = links.clientFor(daemon);

  if (client === null) {
    const state = formatLinkState(daemon, links.stateOf(daemon));

    return Promise.reject(new DaemonUnavailableError(state));
  }

  return client.sendRequest(method, params);
}

export function formatDaemonFailure(daemon: DaemonName, error: unknown): string | null {
  if (error instanceof DaemonUnavailableError) {
    return error.message;
  }

  return daemon === null ? null : `${daemon}: ${formatError(error)}`;
}
