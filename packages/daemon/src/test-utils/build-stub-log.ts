export function buildStubLog() {
  const lines: string[] = [];

  return {
    lines,
    log: (line: string): void => {
      lines.push(line);
    },
  };
}
