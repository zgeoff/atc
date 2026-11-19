import { truncate } from './truncate';

export function truncateSummary(text: string): string {
  return truncate(text, 200, { flatten: true });
}
