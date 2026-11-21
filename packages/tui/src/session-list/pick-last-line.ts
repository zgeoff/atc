export interface LastLineInput {
  readonly prompt: string | null;
  readonly filter: string | null;

  // true while jump mode has narrowed the rows to none
  readonly isJumpEmpty: boolean;
  readonly notice: string | null;
  readonly daemonLine: string | null;
  readonly updateAdvice: string | null;
}

export type LastLine =
  | { readonly kind: 'prompt'; readonly text: string }
  | { readonly kind: 'filter'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'keys' };

// What takes the panel's last line in place of the key bar. When two want it, the first of these
// wins: a prompt, the filter, a notice, a line for a daemon that is down, the advice to update a
// daemon. The jump mode's `no match` shares the filter's place.
export function pickLastLine(input: Readonly<LastLineInput>): LastLine {
  if (input.prompt !== null) {
    return { kind: 'prompt', text: input.prompt };
  }

  if (input.filter !== null) {
    return { kind: 'filter', text: input.filter };
  }

  if (input.isJumpEmpty) {
    return { kind: 'text', text: 'no match' };
  }

  const text = input.notice ?? input.daemonLine ?? input.updateAdvice;

  return text === null ? { kind: 'keys' } : { kind: 'text', text };
}
