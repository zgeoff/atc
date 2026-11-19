import { truncate } from './truncate';

// the cap keeps a single hook payload from blowing up the briefing text.
export function truncateDetail(text: string): string {
  return truncate(text, 600);
}
