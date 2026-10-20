import type { LineInputStep } from '@atc/plugin-api';

// The terminal a line is typed into: a write to it, and whether it is still
// the one the line started on.
interface LineTerminal {
  readonly write: (data: string) => void;
  readonly isLive: () => boolean;
}

export async function writeLineSteps(
  steps: readonly LineInputStep[],
  terminal: LineTerminal,
  wait: (delayMs: number) => Promise<void>,
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
