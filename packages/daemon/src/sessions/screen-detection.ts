import type { Clock, SessionID } from '@atc/core';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

// How long a session's output stays quiet before its screen is judged.
const DETECT_QUIET_MS = 300;

interface ScreenDetectionDeps {
  readonly mgr: Pick<
    SessionManager,
    'hasScreenDetector' | 'sessions' | 'findAdapter' | 'updateAttention'
  >;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // Called for each output whose session's agent has no screen detector.
  readonly onDetectSkipped?: ((sessionID: SessionID) => void) | undefined;
}

export class ScreenDetection {
  private readonly mgr: ScreenDetectionDeps['mgr'];

  private readonly clock: Clock;

  private readonly findRuntime: ScreenDetectionDeps['findRuntime'];

  private readonly onDetectSkipped: ScreenDetectionDeps['onDetectSkipped'];

  constructor(deps: ScreenDetectionDeps) {
    this.mgr = deps.mgr;
    this.clock = deps.clock;
    this.findRuntime = deps.findRuntime;
    this.onDetectSkipped = deps.onDetectSkipped;
  }

  // Each output restarts the wait, so the screen is judged once the
  // output stops.
  scheduleDetect(sessionID: SessionID): void {
    if (!this.mgr.hasScreenDetector) {
      this.onDetectSkipped?.(sessionID);

      return;
    }

    const s = this.mgr.sessions.find((x) => x.id === sessionID);

    const detector =
      s === undefined ? null : (this.mgr.findAdapter(s.agent)?.screenDetector ?? null);

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
    const s = this.mgr.sessions.find((x) => x.id === sessionID);

    const detector =
      s === undefined ? null : (this.mgr.findAdapter(s.agent)?.screenDetector ?? null);

    const model = this.findRuntime(sessionID)?.screen ?? null;

    if (detector === null || model === null) {
      return;
    }

    const screen = await model.renderReplay();

    const judgment = detector.detectAttention(screen);

    if (judgment === 'needs-input') {
      this.mgr.updateAttention(sessionID, 'needs_you', 'waiting at a prompt');
    }

    if (judgment === 'working') {
      this.mgr.updateAttention(sessionID, 'running', 'working');
    }
  }
}
