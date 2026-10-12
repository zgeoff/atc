/**
 * A log sink that records each line it is given, in order, in place of the
 * daemon's stderr log: `log` takes a line and `lines` holds every line taken
 * so far.
 */
export function buildStubLog() {
  const lines: string[] = [];

  return {
    lines,
    log: (line: string): void => {
      lines.push(line);
    },
  };
}
