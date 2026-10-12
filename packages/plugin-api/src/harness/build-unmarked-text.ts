import { PASTE_MARKERS } from './paste-markers';

/**
 * The text with every bracketed paste marker dropped, so it can neither end
 * a paste early nor start one of its own.
 */
export function buildUnmarkedText(text: string): string {
  return text.replaceAll(PASTE_MARKERS.start, '').replaceAll(PASTE_MARKERS.end, '');
}
