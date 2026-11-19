import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

export function writeRecordFile(recordsDir: string, path: string, content: string): void {
  const segments = path.split('/');

  if (!segments.every((segment) => SEGMENT.test(segment))) {
    throw new Error(`the records folder takes no path like ${JSON.stringify(path)}`);
  }

  const file = join(recordsDir, ...segments);
  const staged = join(dirname(file), `.${randomUUID()}.staged`);

  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  writeFileSync(staged, content, { mode: 0o444 });
  chmodSync(staged, 0o444);
  renameSync(staged, file);
}
