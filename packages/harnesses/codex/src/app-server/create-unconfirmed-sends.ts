import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export interface UnconfirmedSends {
  readonly findThread: (message: string) => string | undefined;
  readonly collectMessages: () => string[];

  // The file changes before the call returns, so a daemon that stops right
  // after it still finds the thread.
  readonly setThread: (message: string, thread: string) => void;
  readonly removeMessages: (messages: readonly string[]) => void;
}

// the thread each unconfirmed message went to, kept in a file of the session's own so a daemon
// restart before the recovery still reads that thread; a null path keeps it in memory alone, and
// a file that does not read or write is logged, so recovery reads only the thread the bridge serves
export function createUnconfirmedSends(
  path: string | null,
  log: (line: string) => void,
): UnconfirmedSends {
  const threads = path === null ? new Map<string, string>() : loadThreads(path, log);

  // A rename replaces the file whole, so a stop part way through a write
  // leaves the earlier file. A failed write keeps the memory copy, which
  // serves every recovery until the daemon stops.
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
