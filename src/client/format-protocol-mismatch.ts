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

  // Without a pid the TUI cannot stop the daemon either, so the restart is
  // left to the user.
  const restart =
    mismatch.daemonPID === null
      ? `To restart it, find its pid with \`ss -xlp | grep ${mismatch.socketPath}\` on Linux or \`lsof -U | grep ${mismatch.socketPath}\` on macOS, stop that process, and run \`atc\` again: every hosted session ends, and \`R\` respawns them from their transcripts.`
      : 'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.';

  return [
    `the atc daemon (${pid}, socket ${mismatch.socketPath}) speaks another protocol than this client, ${mismatch.clientBuild} on protocol v${mismatch.clientProtocol}.`,
    `The daemon answered: ${mismatch.daemonMessage}`,
    'It was left running, so the sessions it hosts keep running.',
    restart,
  ].join('\n');
}
