import { DaemonLinkFailureError } from '@atc/tui';
import { AtcError } from '@atcx/contract/light';
import { RemoteTokenError } from '../remote-daemon/remote-token-error';

export function toDaemonLinkFailureError(error: unknown): DaemonLinkFailureError {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof RemoteTokenError) {
    return new DaemonLinkFailureError('unauthorized', message, { cause: error });
  }

  if (error instanceof AtcError && error.code === 'unauthorized') {
    return new DaemonLinkFailureError('unauthorized', message, { cause: error });
  }

  if (error instanceof AtcError && error.code === 'protocol_mismatch') {
    return new DaemonLinkFailureError('mismatched', message, { cause: error });
  }

  return new DaemonLinkFailureError('down', message, { cause: error });
}
