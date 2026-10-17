import type { MessageRefusal } from '../daemon-context';

// thrown out of a keyed send's start so the claim drops and the refusal still answers the request
export class MessageRefusedError extends Error {
  readonly refusal: MessageRefusal;

  constructor(refusal: MessageRefusal) {
    super(`message refused: ${refusal}`);

    this.refusal = refusal;
    this.name = 'MessageRefusedError';
  }
}
