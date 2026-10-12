import type { LineInputStep } from '../agents/agent-adapter';

// The terminal a line is typed into: a write to it, and whether it is still
// the one the line started on.
interface LineTerminal {
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;
}

/**
 * Writes a line's steps to its terminal in order, waiting out each pause.
 * The writes before the first pause go out before the call returns. Settles
 * `ok` once the last step is written, or `dead` at the first write that
 * finds the terminal gone, which then gets none of the rest of the line.
 */
export async function writeLineSteps(
  steps: readonly LineInputStep[],
  terminal: LineTerminal,
  wait: (ms: number) => Promise<void>,
): Promise<'ok' | 'dead'> {
  for (const step of steps) {
    if (typeof step !== 'string') {
      await wait(step.pauseMs);

      continue;
    }

    if (!terminal.isLive()) {
      return 'dead';
    }

    terminal.write(step);
  }

  return 'ok';
}
