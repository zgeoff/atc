import { isClientBehind } from './is-client-behind';

export interface ProtocolMismatch {
  readonly socketPath: string;

  readonly daemonPID: number | null;

  readonly clientBuild: string;
  readonly clientProtocol: number;

  readonly daemonProtocol: number | null;
  readonly clientMajor: number;

  // null when the refusal carried none, which means the daemon is older
  readonly daemonMajor: number | null;

  readonly daemonMessage: string;
}

export function formatProtocolMismatch(mismatch: ProtocolMismatch): string {
  const pid = mismatch.daemonPID === null ? 'pid unknown' : `pid ${mismatch.daemonPID}`;

  if (isClientBehind(mismatch)) {
    return [
      `this client, ${mismatch.clientBuild} on major version ${mismatch.clientMajor}, is older than the atc daemon (${pid}, socket ${mismatch.socketPath}), which runs major version ${mismatch.daemonMajor}.`,
      `The daemon answered: ${mismatch.daemonMessage}`,
      'It was left running, so the sessions it hosts keep running.',
      'To reconnect, update atc if this build is out of date, then quit this client and run `atc` again. A daemon restart cannot help, because the daemon comes back on its own build.',
    ].join('\n');
  }

  const restart =
    mismatch.daemonPID === null
      ? `To restart it, find its pid with \`ss -xlp | grep ${mismatch.socketPath}\` on Linux or \`lsof -U | grep ${mismatch.socketPath}\` on macOS, stop that process, and run \`atc\` again: every hosted session ends, and \`R\` respawns them from their transcripts.`
      : 'To restart it, run `atc` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon.';

  return [
    `the atc daemon (${pid}, socket ${mismatch.socketPath}) speaks another major version than this client, ${mismatch.clientBuild} on major version ${mismatch.clientMajor}.`,
    `The daemon answered: ${mismatch.daemonMessage}`,
    'It was left running, so the sessions it hosts keep running.',
    restart,
  ].join('\n');
}
