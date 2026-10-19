// a refusal about the daemon itself, never an answer the daemon gave
export class GatewayError extends Error {
  readonly code: 'daemon_unavailable' | 'daemon_unauthorized';

  readonly data: Readonly<Record<string, unknown>>;

  constructor(
    code: 'daemon_unavailable' | 'daemon_unauthorized',
    msg: string,
    data: Readonly<Record<string, unknown>>,
  ) {
    super(msg);

    this.code = code;
    this.data = data;
    this.name = 'GatewayError';
  }
}
