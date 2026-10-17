import { join } from 'node:path';
import { resolveHomeDir } from './resolve-home-dir';

export function resolveAgentHome(
  envVar: string,
  defaultDirName: string,
  homeDir: string = resolveHomeDir(),
): string {
  const home = process.env[envVar];

  return home !== undefined && home !== '' ? home : join(homeDir, defaultDirName);
}
