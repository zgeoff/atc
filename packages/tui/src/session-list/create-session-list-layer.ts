import type { Clock } from '@zgeoff/std';
import type { CellBuffer, FrameInfo, Layer } from '../compositor/types';
import { SPINNER_FRAMES } from '../fleet-bar/constants';
import { buildListPanel } from './build-list-panel';
import { DIM_OVER_HOME, DIM_OVER_SESSION } from './constants';
import { paintPanel } from './paint-panel';
import { pickListMotion } from './pick-list-motion';
import type { ListPhase } from './pick-list-motion';
import type { PanelInput, PanelPlan } from './types';

// a frame the fades ask for, a little under 60 Hz
const FADE_FRAME_MS = 16;

// the spinner turns at 10 Hz, as the fleet bar's does
const SPINNER_STEP_MS = 100;

export interface SessionListLayerDeps {
  readonly clock: Pick<Clock, 'now'>;
  readonly animations: boolean;

  // true while the session list is the screen the user works in
  readonly isOpen: () => boolean;

  // true when the screen that follows the list is a session or home, which the panel fades out
  // over. Any other screen takes over at once.
  readonly canFadeOut: () => boolean;

  // true when the layers below the panel show a session, which the panel dims more than home
  readonly isOverSession: () => boolean;

  readonly readInput: (nowMs: number, spinnerFrame: number) => PanelInput;
}

export interface SessionListLayer extends Layer {
  // true from the first frame of the open until the frame that draws the screen without the panel
  readonly isVisible: () => boolean;
}

// The session list as a layer of its own: a panel drawn over the layers below it, which it dims.
// The layer keeps the open and close fades, and keeps the panel it last drew while it fades out.
export function createSessionListLayer(deps: SessionListLayerDeps): SessionListLayer {
  let phase: ListPhase = { kind: 'closed' };
  let shown: PanelPlan | null = null;
  let dimShare = DIM_OVER_SESSION;

  // true from the moment the panel is gone until a frame has drawn the screen without it. A frame
  // can come late, so the last frame drawn can still show a faint panel.
  let isGoneUndrawn = false;

  const readMotion = (nowMs: number) =>
    pickListMotion(phase, nowMs, {
      animations: deps.animations,
      rowCount: shown?.content.length ?? 0,
    });

  const sync = (nowMs: number): void => {
    const wasShown = phase.kind !== 'closed';

    syncPhase(nowMs);

    if (wasShown && phase.kind === 'closed') {
      isGoneUndrawn = true;
    }
  };

  const syncPhase = (nowMs: number): void => {
    const isOpen = deps.isOpen();

    if (isOpen && phase.kind !== 'opening') {
      phase = { kind: 'opening', startedAtMs: nowMs };
    } else if (!isOpen && phase.kind === 'opening') {
      phase = deps.canFadeOut() ? { kind: 'closing', startedAtMs: nowMs } : { kind: 'closed' };
    } else if (!isOpen && phase.kind === 'closing' && !deps.canFadeOut()) {
      phase = { kind: 'closed' };
    }

    if (phase.kind === 'closing' && !readMotion(nowMs).isVisible) {
      phase = { kind: 'closed' };
    }
  };

  return {
    isVisible: () => {
      sync(deps.clock.now());

      return phase.kind !== 'closed' || isGoneUndrawn;
    },

    draw: (buffer: CellBuffer, frame: FrameInfo) => {
      sync(frame.now);

      if (phase.kind === 'closed') {
        isGoneUndrawn = false;

        return;
      }

      if (phase.kind === 'opening') {
        const spinnerFrame = Math.floor(frame.now / SPINNER_STEP_MS) % SPINNER_FRAMES.length;
        const input = deps.readInput(frame.now, spinnerFrame);

        shown = buildListPanel(input, { cols: frame.cols, rows: frame.rows });
        dimShare = deps.isOverSession() ? DIM_OVER_SESSION : DIM_OVER_HOME;
      }

      if (shown !== null) {
        paintPanel(buffer, shown, {
          terminal: frame.terminal,
          motion: readMotion(frame.now),
          dimShare,
        });
      }
    },

    nextFrameAt: (nowMs) => {
      sync(nowMs);

      if (phase.kind === 'closed') {
        return isGoneUndrawn ? nowMs : null;
      }

      if (readMotion(nowMs).isMoving) {
        return nowMs + FADE_FRAME_MS;
      }

      return phase.kind === 'opening' && shown?.isSpinning === true
        ? (Math.floor(nowMs / SPINNER_STEP_MS) + 1) * SPINNER_STEP_MS
        : null;
    },
  };
}
