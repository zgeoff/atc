import type { MessageRefusal } from '../types';

export class MessageRefusedError extends Error {
  readonly refusal: MessageRefusal;

  constructor(refusal: MessageRefusal) {
    super(`message refused: ${refusal}`);

    this.refusal = refusal;
    this.name = 'MessageRefusedError';
  }
}
