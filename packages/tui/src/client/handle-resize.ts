import { ansi } from '@atc/core';
import type { SessionKey } from '../fleet/session-key';
import { cols } from '../terminal/cols';

export interface HandleResizeDeps {
  // the session the TUI holds an attachment to, which a resize reaches in any screen
  readonly attachedKey: SessionKey | null;

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

  if (deps.attachedKey !== null) {
    void deps.sendQuiet(deps.attachedKey.daemon, 'session.resize', {
      session: deps.attachedKey.id,
      cols: cols(),
      rows: deps.ptyRows,
    });
  }

  deps.drawMode();
}
