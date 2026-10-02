/**
 * Thrown by an idempotent effect's start when it failed after the effect
 * began and could not confirm taking it back, so the effect may still stand.
 * The ledger keeps the key as outcome_unknown instead of releasing it, and a
 * retry under the key never runs the effect a second time.
 */
export class EffectRemainsError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'EffectRemainsError';
  }
}
