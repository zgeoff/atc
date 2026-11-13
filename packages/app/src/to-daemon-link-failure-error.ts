import { DaemonError } from '@atc/protocol/wire';
import { DaemonLinkFailureError } from '@atc/tui';
import { RemoteTokenError } from './remote-token-error';

// Classifies a remote boot's failure into the state the TUI's link takes: a token the client
// cannot read or the daemon refuses is `unauthorized`, a daemon on another protocol is
// `mismatched`, and anything else, such as an unreachable daemon, is `down`.
export function toDaemonLinkFailureError(error: unknown): DaemonLinkFailureError {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof RemoteTokenError) {
    return new DaemonLinkFailureError('unauthorized', message, { cause: error });
  }

  if (error instanceof DaemonError && error.code === 'unauthorized') {
    return new DaemonLinkFailureError('unauthorized', message, { cause: error });
  }

  if (error instanceof DaemonError && error.code === 'protocol_mismatch') {
    return new DaemonLinkFailureError('mismatched', message, { cause: error });
  }

  return new DaemonLinkFailureError('down', message, { cause: error });
}
