/**
 * A terminal that keeps every chunk written to it, in order, and draws
 * nothing. `getText` returns everything written since the start or the
 * last `reset`, which drops what came before, so a test reads only the
 * output of the action it checks.
 */
export function buildStubTerminal() {
  const chunks: string[] = [];

  return {
    write: (chunk: string): void => {
      chunks.push(chunk);
    },
    getText: (): string => chunks.join(''),
    reset: (): void => {
      chunks.length = 0;
    },
  };
}
