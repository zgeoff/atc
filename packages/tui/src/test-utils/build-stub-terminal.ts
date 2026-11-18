export function buildStubTerminal() {
  const chunks: string[] = [];

  return {
    write: (chunk: string): void => {
      chunks.push(chunk);
    },
    getText: (): string => chunks.join(''),
    countChunks: (): number => chunks.length,
    getTextSince: (mark: number): string => chunks.slice(mark).join(''),
  };
}
