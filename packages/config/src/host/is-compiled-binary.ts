import { basename } from 'node:path';

export function isCompiledBinary(): boolean {
  const exec = basename(process.execPath);

  return exec !== 'bun' && exec !== 'bun.exe';
}
