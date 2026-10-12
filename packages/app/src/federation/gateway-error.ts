/**
 * A refusal the gateway makes about a daemon itself, as opposed to an
 * answer a daemon gave: `daemon_unavailable` when the daemon never received
 * the request, `daemon_unauthorized` when it refused the gateway's token,
 * and `daemon_outdated` when it lacks a feature the request needs. `data`
 * holds the daemon's name, and for a pin mismatch the reason
 * `daemon_changed`.
 */
export class GatewayError extends Error {
  readonly code: 'daemon_unavailable' | 'daemon_unauthorized' | 'daemon_outdated';

  readonly data: Readonly<Record<string, unknown>>;

  constructor(
    code: 'daemon_unavailable' | 'daemon_unauthorized' | 'daemon_outdated',
    msg: string,
    data: Readonly<Record<string, unknown>>,
  ) {
    super(msg);

    this.code = code;
    this.data = data;
    this.name = 'GatewayError';
  }
}
