import { basename } from 'node:path';

/**
 * Whether this process is a compiled atc binary rather than bun running the
 * source tree: the binary is then its own CLI entry, and nothing under
 * node_modules exists at runtime.
 */
export function isCompiledBinary(): boolean {
  const exec = basename(process.execPath);

  return exec !== 'bun' && exec !== 'bun.exe';
}
