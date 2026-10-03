import { readFileSync } from 'node:fs';
import { ImpPortError } from './imp-port-error';

/**
 * The impd token held in the file at `path`, without one trailing newline.
 * An empty or unreadable file throws an `UNAUTHORIZED` port error whose
 * message holds the path and the read's error code, never file content.
 */
export function readImpToken(path: string): string {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown error';

    throw new ImpPortError('UNAUTHORIZED', `cannot read the impd token file ${path}: ${code}`);
  }

  const token = text.endsWith('\n') ? text.slice(0, -1) : text;

  if (token === '') {
    throw new ImpPortError('UNAUTHORIZED', `the impd token file ${path} is empty`);
  }

  return token;
}
