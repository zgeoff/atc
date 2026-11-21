import type { RGB } from '../compositor/types';
import { parseColourAnswer } from './parse-colour-answer';

export type TerminalAnswer =
  | { readonly kind: 'foreground'; readonly colour: RGB }
  | { readonly kind: 'background'; readonly colour: RGB }
  | { readonly kind: 'kitty' }
  | { readonly kind: 'attributes' };

export interface TerminalAnswerFilter {
  // Takes a chunk of the terminal's input as latin1 text, and splits it into the keys and the
  // answers to the TUI's start-up questions. A sequence cut at the end of a chunk is held for the
  // next one.
  readonly push: (chunk: string) => { readonly keys: string; readonly answers: TerminalAnswer[] };
}

const ESC = '\u001B';

const COLOUR_ANSWER = new RegExp(
  `${ESC}\\]1(?<which>[01]);(?<data>[^\\u0007${ESC}]*)(?:\\u0007|${ESC}\\\\)`,
  'gu',
);

const KITTY_ANSWER = new RegExp(`${ESC}\\[\\?\\d*u`, 'gu');
const ATTRIBUTES_ANSWER = new RegExp(`${ESC}\\[\\?[\\d;:]*c`, 'gu');

// The longest start of an answer that no key shares: an OSC 10 or 11, or CSI ?.
const PARTIAL_ANSWER = new RegExp(
  `(?:${ESC}\\]1(?:[01](?:;[^\\u0007${ESC}]*${ESC}?)?)?|${ESC}\\[\\?[\\d;:]*)$`,
  'u',
);

export function createTerminalAnswerFilter(): TerminalAnswerFilter {
  let held = '';

  return {
    push: (chunk) => {
      const text = held + chunk;
      const partial = PARTIAL_ANSWER.exec(text);

      held = partial === null ? '' : partial[0];

      const complete = partial === null ? text : text.slice(0, partial.index);
      const answers: TerminalAnswer[] = [];

      const withoutColours = complete.replaceAll(COLOUR_ANSWER, (...args: unknown[]) => {
        const groups = args.at(-1);
        const data = isGroups(groups) ? (groups['data'] ?? '') : '';
        const colour = parseColourAnswer(data);

        if (colour !== null) {
          answers.push({
            kind: isGroups(groups) && groups['which'] === '0' ? 'foreground' : 'background',
            colour,
          });
        }

        return '';
      });

      const withoutKitty = withoutColours.replaceAll(KITTY_ANSWER, () => {
        answers.push({ kind: 'kitty' });

        return '';
      });

      const keys = withoutKitty.replaceAll(ATTRIBUTES_ANSWER, () => {
        answers.push({ kind: 'attributes' });

        return '';
      });

      return { keys, answers };
    },
  };
}

function isGroups(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null;
}
