// the effect may still stand, so the ledger keeps the key as outcome_unknown
// instead of releasing it, and a retry never runs the effect again.
export class EffectRemainsError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'EffectRemainsError';
  }
}
