import { isRecord } from '@atc/core';
import type { Terminal } from '@xterm/headless';

export interface ScrollRegion {
  readonly top: number;
  readonly bottom: number;
}

export interface EmulatorInternals {
  readonly normalRegion: ScrollRegion | null;
  readonly altRegion: ScrollRegion | null;
  readonly isCursorHidden: boolean;
}

// xterm's public API exposes neither the scroll region of each buffer nor the cursor's
// visibility, and the serialize addon omits both.
export function readEmulatorInternals(term: Terminal): EmulatorInternals {
  const core: unknown = Reflect.get(term, '_core');
  const buffers = readMember(core, 'buffers');
  const coreService = readMember(core, 'coreService');

  return {
    normalRegion: readRegion(readMember(buffers, 'normal'), term.rows),
    altRegion: readRegion(readMember(buffers, 'alt'), term.rows),
    isCursorHidden: readMember(coreService, 'isCursorHidden') === true,
  };
}

function readMember(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readRegion(buffer: unknown, rows: number): ScrollRegion | null {
  if (!isRecord(buffer)) {
    return null;
  }

  const top = buffer['scrollTop'];
  const bottom = buffer['scrollBottom'];

  if (typeof top !== 'number' || typeof bottom !== 'number') {
    return null;
  }

  return top === 0 && bottom === rows - 1 ? null : { top, bottom };
}
