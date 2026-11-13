import { formatError } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { formatLinkState } from './daemon-link-state';
import type { DaemonLinkState } from './daemon-link-state';
import { DaemonUnavailableError } from './daemon-unavailable-error';
import type { DaemonName } from './session-key';

// What a request needs of the links: the client of a daemon whose link is up, and where each
// link stands.
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

// What the status bar says about a request that failed on a daemon: a link that is not up says
// its own state, and a remote daemon's refusal says the daemon's name with it. A failure on the
// local daemon says nothing here.
export function formatDaemonFailure(daemon: DaemonName, error: unknown): string | null {
  if (error instanceof DaemonUnavailableError) {
    return error.message;
  }

  return daemon === null ? null : `${daemon}: ${formatError(error)}`;
}
