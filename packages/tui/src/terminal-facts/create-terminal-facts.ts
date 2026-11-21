import type { Clock } from '@atc/core';
import { pickColourDepth } from '../compositor/pick-colour-depth';
import type { TerminalFacts } from '../compositor/types';
import type { TerminalAnswer } from './create-terminal-answer-filter';

export const ANSWER_WAIT_MS = 150;

export interface TerminalFactsDeps {
  readonly env: { readonly colorterm: string | undefined; readonly term: string | undefined };
  readonly clock: Clock;
  readonly write: (chunk: string) => void;
  readonly onChange: () => void;
}

export interface TerminalFactsStore {
  readonly read: () => TerminalFacts;

  // asks the user's terminal for its colours and its keyboard protocol
  readonly start: () => void;
  readonly apply: (answer: TerminalAnswer) => void;
}

const QUERIES = '\u001B]10;?\u001B\\\u001B]11;?\u001B\\\u001B[?u\u001B[c';

export function createTerminalFacts(deps: TerminalFactsDeps): TerminalFactsStore {
  let facts: TerminalFacts = {
    depth: pickColourDepth(deps.env),
    background: { red: 13, green: 17, blue: 23 },
    foreground: { red: 201, green: 209, blue: 217 },
    kittyKeyboard: false,
  };

  let isWaiting = false;

  return {
    read: () => facts,

    start: () => {
      isWaiting = true;

      deps.write(QUERIES);

      deps.clock.schedule(() => {
        isWaiting = false;
      }, ANSWER_WAIT_MS);
    },

    apply: (answer) => {
      if (!isWaiting) {
        return;
      }

      if (answer.kind === 'attributes') {
        isWaiting = false;

        return;
      }

      if (answer.kind === 'kitty') {
        facts = { ...facts, kittyKeyboard: true };
      } else if (answer.kind === 'foreground') {
        facts = { ...facts, foreground: answer.colour };
      } else {
        facts = { ...facts, background: answer.colour };
      }

      deps.onChange();
    },
  };
}
