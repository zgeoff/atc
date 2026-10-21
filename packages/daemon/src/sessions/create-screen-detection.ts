import type { Clock, SessionID } from '@atc/core';
import type { SessionRuntime } from './create-session-runtime';
import type { SessionManager } from './sessions';

// How long a session's output stays quiet before its screen is judged.
const DETECT_QUIET_MS = 300;

interface ScreenDetectionDeps {
  readonly manager: Pick<
    SessionManager,
    'hasScreenDetector' | 'sessions' | 'findAdapter' | 'updateAttention'
  >;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // Called for each output whose session's agent has no screen detector.
  readonly onDetectSkipped?: ((sessionID: SessionID) => void) | undefined;
}

export interface ScreenDetection {
  // Each output restarts the wait, so the screen is judged once the
  // output stops.
  readonly scheduleDetect: (sessionID: SessionID) => void;
}

export function createScreenDetection(deps: ScreenDetectionDeps): ScreenDetection {
  const manager = deps.manager;
  const clock = deps.clock;
  const findRuntime = deps.findRuntime;
  const onDetectSkipped = deps.onDetectSkipped;

  const applyScreenJudgment = async (sessionID: SessionID): Promise<void> => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    const detector =
      session === undefined ? null : (manager.findAdapter(session.agent)?.screenDetector ?? null);

    const model = findRuntime(sessionID)?.screen ?? null;

    if (detector === null || model === null) {
      return;
    }

    const screen = await model.captureReplay();

    const judgment = detector.detectAttention(screen);

    if (judgment === 'needs-input') {
      manager.updateAttention(sessionID, 'needs_you', 'waiting at a prompt');
    }

    if (judgment === 'working') {
      manager.updateAttention(sessionID, 'running', 'working');
    }
  };

  return {
    scheduleDetect: (sessionID) => {
      if (!manager.hasScreenDetector) {
        onDetectSkipped?.(sessionID);

        return;
      }

      const session = manager.sessions.find((x) => x.id === sessionID);

      const detector =
        session === undefined ? null : (manager.findAdapter(session.agent)?.screenDetector ?? null);

      const runtime = findRuntime(sessionID);

      if (detector === null) {
        onDetectSkipped?.(sessionID);
      }

      if (detector === null || runtime === undefined) {
        return;
      }

      runtime.cancelDetect?.();

      runtime.cancelDetect = clock.schedule(() => {
        runtime.cancelDetect = undefined;
        void applyScreenJudgment(sessionID);
      }, DETECT_QUIET_MS);
    },
  };
}
