// A daemon that refused this client's handshake because it speaks another
// protocol version.
export interface ProtocolMismatch {
  readonly socketPath: string;

  // The daemon's pid from its record or pid file, or null when neither
  // belongs to the socket that refused.
  readonly daemonPID: number | null;

  readonly clientBuild: string;
  readonly clientProtocol: number;

  // The daemon's own refusal, which holds its build and protocol version.
  readonly daemonMessage: string;
}

/**
 * Describes a daemon on another protocol version: both builds and both
 * versions, that it was left running, and how to restart it on purpose.
 */
export function formatProtocolMismatch(mismatch: ProtocolMismatch): string {
  const pid = mismatch.daemonPID === null ? 'pid unknown' : `pid ${mismatch.daemonPID}`;

  return [
    `the atc daemon (${pid}, socket ${mismatch.socketPath}) speaks another protocol than this client, ${mismatch.clientBuild} on protocol v${mismatch.clientProtocol}.`,
    `The daemon answered: ${mismatch.daemonMessage}`,
    'It was left running, so the sessions it hosts keep running.',
    'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.',
  ].join('\n');
}
