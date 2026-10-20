// a refusal about the daemon itself, never an answer the daemon gave
export class GatewayError extends Error {
  readonly code: 'daemon_unavailable' | 'daemon_unauthorized';

  readonly data: Readonly<Record<string, unknown>>;

  constructor(
    code: 'daemon_unavailable' | 'daemon_unauthorized',
    message: string,
    data: Readonly<Record<string, unknown>>,
  ) {
    super(message);

    this.code = code;
    this.data = data;
    this.name = 'GatewayError';
  }
}
