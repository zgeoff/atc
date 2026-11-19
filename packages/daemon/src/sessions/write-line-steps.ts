import type { LineInputStep } from '@atc/plugin-api';

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
