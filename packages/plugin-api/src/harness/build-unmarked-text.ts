import { PASTE_MARKERS } from './paste-markers';

export function buildUnmarkedText(text: string): string {
  return text.replaceAll(PASTE_MARKERS.start, '').replaceAll(PASTE_MARKERS.end, '');
}
