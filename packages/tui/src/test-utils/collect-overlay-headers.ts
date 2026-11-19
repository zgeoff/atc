import { KEYS } from '@atc/core/test-utils/keys';

export function collectOverlayHeaders(output: string): string[] {
  return output
    .split(`${KEYS.esc}[90m▸ `)
    .slice(1)
    .map((part) => part.split(`${KEYS.esc}[0m`)[0] ?? '');
}
