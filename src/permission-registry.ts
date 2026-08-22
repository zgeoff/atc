import type { SessionID } from './session-id';

export interface PermissionRequest {
  readonly id: string;
  readonly sessionID: SessionID;
  readonly message: string;
  readonly respondable: boolean;
}

export type AnswerResult = 'ok' | 'already_answered' | 'unsupported' | 'unknown';

interface PendingRequest {
  readonly req: PermissionRequest;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Pending permission requests with first-response-wins arbitration. The
 * first answer resolves a request and every later answer reports
 * already_answered; an unanswered request times out to deny; requests that
 * stop mattering (the session was answered directly or died) resolve as
 * dismissed. Resolution always reaches the callbacks exactly once.
 */
export class PermissionRegistry {
  onRequested: (req: PermissionRequest) => void = () => {};

  onResolved: (id: string, decision: string) => void = () => {};

  private readonly timeoutMs: number;

  private readonly pending = new Map<string, PendingRequest>();

  private readonly resolved = new Set<string>();

  private counter = 0;

  constructor(timeoutMs = 60_000) {
    this.timeoutMs = timeoutMs;
  }

  open(sessionID: SessionID, message: string, respondable: boolean): PermissionRequest {
    const id = `p${++this.counter}`;
    const req: PermissionRequest = { id, sessionID, message, respondable };

    const timer = setTimeout(() => {
      this.removeRequest(id, 'deny');
    }, this.timeoutMs);

    this.pending.set(id, { req, timer });
    this.onRequested(req);

    return req;
  }

  answer(id: string, decision: string): AnswerResult {
    if (this.resolved.has(id)) {
      return 'already_answered';
    }

    const entry = this.pending.get(id);

    if (entry === undefined) {
      return 'unknown';
    }

    if (!entry.req.respondable) {
      return 'unsupported';
    }

    this.removeRequest(id, decision);

    return 'ok';
  }

  answerAll(sessionID: SessionID, decision: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.req.sessionID === sessionID) {
        this.removeRequest(id, decision);
      }
    }
  }

  private removeRequest(id: string, decision: string): void {
    const entry = this.pending.get(id);

    if (entry === undefined) {
      return;
    }

    clearTimeout(entry.timer);

    this.pending.delete(id);
    this.resolved.add(id);

    // The resolved set only exists to tell already_answered from unknown;
    // cap it so a long-lived daemon cannot grow it without bound.
    if (this.resolved.size > 1000) {
      for (const oldest of this.resolved) {
        this.resolved.delete(oldest);
        break;
      }
    }

    this.onResolved(id, decision);
  }
}
