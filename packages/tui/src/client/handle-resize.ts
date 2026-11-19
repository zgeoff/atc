import { ansi } from '@atc/core';
import type { SessionKey } from '../fleet/session-key';
import { cols } from '../terminal/cols';
import type { ClientMode } from './build-client-machine';

export interface HandleResizeDeps {
  readonly mode: ClientMode;
  readonly focusedKey: SessionKey | null;

  readonly restartPrompt: string | null;
  readonly ptyRows: number;
  readonly write: (chunk: string) => void;
  readonly sendQuiet: (
    daemon: SessionKey['daemon'],
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly drawMode: () => void;
}

export function handleResize(deps: HandleResizeDeps): void {
  if (deps.restartPrompt !== null) {
    deps.write(ansi.clear + deps.restartPrompt);

    return;
  }

  if (deps.mode === 'attached' && deps.focusedKey !== null) {
    void deps.sendQuiet(deps.focusedKey.daemon, 'session.resize', {
      session: deps.focusedKey.id,
      cols: cols(),
      rows: deps.ptyRows,
    });
  }

  deps.drawMode();
}
