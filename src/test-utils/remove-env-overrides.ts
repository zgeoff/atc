import { envOriginals } from './env-originals';

/**
 * Puts every overridden environment variable back to the value it held before
 * its first override, unsetting one that was unset, and forgets the recorded
 * values.
 */
export function removeEnvOverrides(): void {
  for (const [key, value] of envOriginals) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  envOriginals.clear();
}
