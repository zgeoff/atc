import type { MessageRefusal } from '../types';

// A keyed send must throw rather than return, so the claim on its key is dropped.
// The caller catches this error and still answers the request with the refusal.
export class MessageRefusedError extends Error {
  readonly refusal: MessageRefusal;

  constructor(refusal: MessageRefusal) {
    super(`message refused: ${refusal}`);

    this.refusal = refusal;
    this.name = 'MessageRefusedError';
  }
}
