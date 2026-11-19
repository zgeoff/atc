import { readFileSync } from 'node:fs';
import { ImpPortError } from '../port/imp-port-error';

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
