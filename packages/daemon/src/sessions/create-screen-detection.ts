import type { Clock } from '@atc/core';
import type { SessionID } from '@atcx/contract';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';

// How long a session's output stays quiet before its screen is judged.
const DETECT_QUIET_MS = 300;
const NEEDS_INPUT_MESSAGE = 'waiting at a prompt';

interface ScreenDetectionDeps {
  readonly manager: Pick<
    SessionManager,
    'hasScreenDetector' | 'sessions' | 'findAdapter' | 'updateAttention'
  >;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  readonly recordNeedsInput: (sessionID: SessionID, message: string) => Promise<boolean>;

  // Called for each output whose session's agent has no screen detector.
  readonly onDetectSkipped?: ((sessionID: SessionID) => void) | undefined;
}

export interface ScreenDetection {
  // Each output restarts the wait, so the screen is judged once the
  // output stops.
  readonly scheduleDetect: (sessionID: SessionID) => void;
  readonly applyAgentStart: (sessionID: SessionID) => void;
}

export function createScreenDetection(deps: ScreenDetectionDeps): ScreenDetection {
  const manager = deps.manager;
  const clock = deps.clock;
  const findRuntime = deps.findRuntime;
  const recordNeedsInput = deps.recordNeedsInput;
  const onDetectSkipped = deps.onDetectSkipped;

  const findDetector = (sessionID: SessionID) => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    return session === undefined
      ? null
      : (manager.findAdapter(session.agent)?.screenDetector ?? null);
  };

  const applyScreenJudgment = async (sessionID: SessionID): Promise<void> => {
    const detector = findDetector(sessionID);
    const runtime = findRuntime(sessionID);
    const model = runtime?.screen ?? null;

    if (detector === null || runtime === undefined || model === null) {
      return;
    }

    const screen = await model.captureText();

    if (detector.untilAgentStart && runtime.startedAt !== null) {
      return;
    }

    const judgment = detector.detectAttention(screen.text);

    if (judgment === 'needs-input') {
      const isFlagged = manager.updateAttention(sessionID, 'needs_you', NEEDS_INPUT_MESSAGE);

      if (isFlagged) {
        runtime.needsYouFromScreen = true;
      }

      const isStillNeedsYou =
        manager.sessions.find((x) => x.id === sessionID)?.state === 'needs_you';

      if (isFlagged || (runtime.needsInputUnrecorded && isStillNeedsYou)) {
        runtime.needsInputUnrecorded = false;

        if (!(await recordNeedsInput(sessionID, NEEDS_INPUT_MESSAGE))) {
          runtime.needsInputUnrecorded = true;
        }
      }
    }

    if (judgment === 'working' && manager.updateAttention(sessionID, 'running', 'working')) {
      runtime.needsYouFromScreen = false;
      runtime.needsInputUnrecorded = false;
    }
  };

  return {
    scheduleDetect: (sessionID) => {
      if (!manager.hasScreenDetector) {
        onDetectSkipped?.(sessionID);

        return;
      }

      const detector = findDetector(sessionID);
      const runtime = findRuntime(sessionID);

      if (detector === null) {
        onDetectSkipped?.(sessionID);
      }

      if (detector === null || runtime === undefined) {
        return;
      }

      if (detector.untilAgentStart && runtime.startedAt !== null) {
        return;
      }

      runtime.cancelDetect?.();

      runtime.cancelDetect = clock.schedule(() => {
        runtime.cancelDetect = undefined;
        void applyScreenJudgment(sessionID);
      }, DETECT_QUIET_MS);
    },

    applyAgentStart: (sessionID) => {
      const runtime = findRuntime(sessionID);

      if (findDetector(sessionID)?.untilAgentStart !== true || runtime === undefined) {
        return;
      }

      runtime.cancelDetect?.();
      runtime.cancelDetect = undefined;
      runtime.needsInputUnrecorded = false;

      if (runtime.needsYouFromScreen) {
        runtime.needsYouFromScreen = false;

        manager.updateAttention(sessionID, 'running', 'started');
      }
    },
  };
}
