import { envOriginals } from './env-originals';

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
