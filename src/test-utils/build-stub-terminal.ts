/**
 * A terminal that keeps every chunk written to it, in order, and draws
 * nothing. `getText` returns everything written. `mark` returns a position
 * at the end of what is written so far, and `getTextSince` returns only
 * what was written after that position, so a test reads only the output of
 * the action it checks.
 */
export function buildStubTerminal() {
  const chunks: string[] = [];

  return {
    write: (chunk: string): void => {
      chunks.push(chunk);
    },
    getText: (): string => chunks.join(''),
    mark: (): number => chunks.length,
    getTextSince: (mark: number): string => chunks.slice(mark).join(''),
  };
}
