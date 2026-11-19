// Why a daemon's boot failed, as the link records it. The app's remote boot classifies each
// failure into one of these kinds.
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
