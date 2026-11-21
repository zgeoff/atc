import { NO_INPUT_MODES } from '@atc/core';
import type { InputModes } from '@atc/core';
import { formatModeTransition } from '../input-modes/format-mode-transition';

export interface ModeMirrorDeps {
  readonly write: (chunk: string) => void;
  readonly hasKittyKeyboard: () => boolean;

  // the modes the session has set, or null while no session shows
  readonly readSessionModes: () => InputModes | null;
  readonly isSessionFocused: () => boolean;
}

export interface ModeMirror {
  // puts the user's terminal into the session's modes while the session has focus, and into the
  // TUI's own while another layer has focus
  readonly sync: () => void;

  // takes every mirrored mode off the terminal
  readonly reset: () => void;
}

export function createModeMirror(deps: ModeMirrorDeps): ModeMirror {
  let applied: InputModes = NO_INPUT_MODES;

  const apply = (target: InputModes): void => {
    const hasKitty = deps.hasKittyKeyboard();
    const sequence = formatModeTransition(applied, target, hasKitty);

    // the kitty flags count as applied only once they reach a terminal that has the protocol
    applied = hasKitty ? target : { ...target, kittyStack: applied.kittyStack };

    if (sequence !== '') {
      deps.write(sequence);
    }
  };

  return {
    sync: () => {
      const modes = deps.readSessionModes();
      const target = deps.isSessionFocused() && modes !== null ? modes : NO_INPUT_MODES;

      apply(target);
    },

    reset: () => {
      apply(NO_INPUT_MODES);
    },
  };
}
