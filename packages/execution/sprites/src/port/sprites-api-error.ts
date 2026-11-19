export class SpritesApiError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string, options?: ErrorOptions) {
    super(message, options);

    this.name = 'SpritesApiError';
    this.status = status;
  }
}
