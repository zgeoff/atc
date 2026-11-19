import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export interface UnconfirmedSends {
  readonly findThread: (message: string) => string | undefined;
  readonly collectMessages: () => string[];

  readonly setThread: (message: string, thread: string) => void;
  readonly removeMessages: (messages: readonly string[]) => void;
}

export function createUnconfirmedSends(
  path: string | null,
  log: (line: string) => void,
): UnconfirmedSends {
  const threads = path === null ? new Map<string, string>() : loadThreads(path, log);

  const writeThreads = (): void => {
    if (path === null) {
      return;
    }

    const next = `${path}.next`;

    try {
      writeFileSync(next, JSON.stringify(Object.fromEntries(threads)), { mode: 0o600 });
      renameSync(next, path);
    } catch (error) {
      log(`codex app server: the unconfirmed sends in ${path} did not write (${String(error)})`);
    }
  };

  return {
    findThread: (message) => threads.get(message),

    collectMessages: () => [...threads.keys()],

    setThread: (message, thread) => {
      threads.set(message, thread);

      writeThreads();
    },

    removeMessages: (messages) => {
      const before = threads.size;

      for (const message of messages) {
        threads.delete(message);
      }

      if (threads.size !== before) {
        writeThreads();
      }
    },
  };
}

const SENDS_SCHEMA = z.record(z.string(), z.string());

function loadThreads(path: string, log: (line: string) => void): Map<string, string> {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Map<string, string>();
    }

    log(`codex app server: the unconfirmed sends in ${path} did not read (${String(error)})`);

    return new Map<string, string>();
  }

  try {
    const threads = SENDS_SCHEMA.parse(JSON.parse(text));

    return new Map(Object.entries(threads));
  } catch (error) {
    log(`codex app server: the unconfirmed sends in ${path} did not parse (${String(error)})`);

    return new Map<string, string>();
  }
}
