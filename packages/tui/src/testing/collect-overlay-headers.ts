import { KEYS } from '@atc/test-utils';

// The text of each dim group header the session list draws, in the order the output holds them.
export function collectOverlayHeaders(output: string): string[] {
  return output
    .split(`${KEYS.esc}[90m▸ `)
    .slice(1)
    .map((part) => part.split(`${KEYS.esc}[0m`)[0] ?? '');
}
