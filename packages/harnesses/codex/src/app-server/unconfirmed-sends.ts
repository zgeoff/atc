import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const SENDS_SCHEMA = z.record(z.string(), z.string());

// the thread each unconfirmed message went to, kept in a file of the session's own so a daemon
// restart before the recovery still reads that thread; a null path keeps it in memory alone, and
// a file that does not read or write is logged, so recovery reads only the thread the bridge serves
export class UnconfirmedSends {
  private readonly path: string | null;

  private readonly log: (line: string) => void;

  private readonly threads: Map<string, string>;

  constructor(path: string | null, log: (line: string) => void) {
    this.path = path;
    this.log = log;
    this.threads = path === null ? new Map() : loadThreads(path, log);
  }

  findThread(message: string): string | undefined {
    return this.threads.get(message);
  }

  collectMessages(): string[] {
    return [...this.threads.keys()];
  }

  // The file changes before the call returns, so a daemon that stops right
  // after it still finds the thread.
  setThread(message: string, thread: string): void {
    this.threads.set(message, thread);
    this.writeThreads();
  }

  removeMessages(messages: readonly string[]): void {
    const before = this.threads.size;

    for (const message of messages) {
      this.threads.delete(message);
    }

    if (this.threads.size !== before) {
      this.writeThreads();
    }
  }

  // A rename replaces the file whole, so a stop part way through a write
  // leaves the earlier file. A failed write keeps the memory copy, which
  // serves every recovery until the daemon stops.
  private writeThreads(): void {
    if (this.path === null) {
      return;
    }

    const next = `${this.path}.next`;

    try {
      writeFileSync(next, JSON.stringify(Object.fromEntries(this.threads)), { mode: 0o600 });
      renameSync(next, this.path);
    } catch (error) {
      this.log(
        `codex app server: the unconfirmed sends in ${this.path} did not write (${String(error)})`,
      );
    }
  }
}

function loadThreads(path: string, log: (line: string) => void): Map<string, string> {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return new Map();
    }

    log(`codex app server: the unconfirmed sends in ${path} did not read (${String(error)})`);

    return new Map();
  }

  try {
    const threads = SENDS_SCHEMA.parse(JSON.parse(text));

    return new Map(Object.entries(threads));
  } catch (error) {
    log(`codex app server: the unconfirmed sends in ${path} did not parse (${String(error)})`);

    return new Map();
  }
}
