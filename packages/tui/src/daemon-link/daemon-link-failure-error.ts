export class DaemonLinkFailureError extends Error {
  readonly kind: 'down' | 'unauthorized' | 'mismatched';

  constructor(
    kind: 'down' | 'unauthorized' | 'mismatched',
    message: string,
    options?: Readonly<ErrorOptions>,
  ) {
    super(message, options);

    this.name = 'DaemonLinkFailureError';
    this.kind = kind;
  }
}
