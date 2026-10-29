import type { ExecutionProvider } from '@atc/plugin-api';
import {
  NO_TRANSCRIPT_CODE,
  READ_TRANSCRIPT_WINDOW_SCRIPT,
  buildTranscriptWindowArgs,
  parseTranscriptWindow,
} from './guest-transcript-window';
import type { ReadTranscriptWindow } from './load-transcript-page';

export function makeGuestTranscriptReader(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  host: string,
): ReadTranscriptWindow {
  return async (path, offset, length) => {
    const read = await provider.runCommand({
      argv: [
        'sh',
        '-c',
        READ_TRANSCRIPT_WINDOW_SCRIPT,
        'sh',
        ...buildTranscriptWindowArgs(path, offset, length),
      ],
      cwd: '/',
      host,
    });

    if (read.exitCode === NO_TRANSCRIPT_CODE) {
      return null;
    }

    const window = read.exitCode === 0 ? parseTranscriptWindow(read.stdout, offset, length) : null;

    if (window === null) {
      throw new Error(`reading ${path} on host ${host} failed: ${read.stderr.trim()}`);
    }

    return window;
  };
}
