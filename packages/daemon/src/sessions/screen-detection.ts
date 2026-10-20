import type { Clock, SessionID } from '@atc/core';
import type { SessionRuntime } from './session-runtime';
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

export class ScreenDetection {
  private readonly manager: ScreenDetectionDeps['manager'];

  private readonly clock: Clock;

  private readonly findRuntime: ScreenDetectionDeps['findRuntime'];

  private readonly onDetectSkipped: ScreenDetectionDeps['onDetectSkipped'];

  constructor(deps: ScreenDetectionDeps) {
    this.manager = deps.manager;
    this.clock = deps.clock;
    this.findRuntime = deps.findRuntime;
    this.onDetectSkipped = deps.onDetectSkipped;
  }

  // Each output restarts the wait, so the screen is judged once the
  // output stops.
  scheduleDetect(sessionID: SessionID): void {
    if (!this.manager.hasScreenDetector) {
      this.onDetectSkipped?.(sessionID);

      return;
    }

    const session = this.manager.sessions.find((x) => x.id === sessionID);

    const detector =
      session === undefined
        ? null
        : (this.manager.findAdapter(session.agent)?.screenDetector ?? null);

    const runtime = this.findRuntime(sessionID);

    if (detector === null) {
      this.onDetectSkipped?.(sessionID);
    }

    if (detector === null || runtime === undefined) {
      return;
    }

    runtime.cancelDetect?.();

    runtime.cancelDetect = this.clock.schedule(() => {
      runtime.cancelDetect = undefined;
      void this.applyScreenJudgment(sessionID);
    }, DETECT_QUIET_MS);
  }

  private async applyScreenJudgment(sessionID: SessionID): Promise<void> {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    const detector =
      session === undefined
        ? null
        : (this.manager.findAdapter(session.agent)?.screenDetector ?? null);

    const model = this.findRuntime(sessionID)?.screen ?? null;

    if (detector === null || model === null) {
      return;
    }

    const screen = await model.captureReplay();

    const judgment = detector.detectAttention(screen);

    if (judgment === 'needs-input') {
      this.manager.updateAttention(sessionID, 'needs_you', 'waiting at a prompt');
    }

    if (judgment === 'working') {
      this.manager.updateAttention(sessionID, 'running', 'working');
    }
  }
}
