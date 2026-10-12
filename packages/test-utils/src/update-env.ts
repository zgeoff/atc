import { envOriginals } from './env-originals';

/**
 * Overrides an environment variable for the rest of the running test, or
 * unsets it when the value is `undefined`. The value it held before the
 * test's first override of it is recorded once, and the preload puts it back
 * after the test.
 */
export function updateEnv(key: string, value: string | undefined): void {
  if (!envOriginals.has(key)) {
    envOriginals.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
