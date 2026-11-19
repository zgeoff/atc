export class EffectRemainsError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'EffectRemainsError';
  }
}
