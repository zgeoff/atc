import { envOriginals } from './env-originals';

export function updateEnv(key: string, value: string | undefined): void {
  if (!envOriginals.has(key)) {
    // The preload puts back the value held before the test's first override.
    envOriginals.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
