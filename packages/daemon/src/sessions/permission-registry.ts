import type { Clock, SessionID } from '@atc/core';
import { systemClock } from '@atc/core';
import { LRUCache } from 'lru-cache';

export interface PermissionRequest {
  readonly id: string;
  readonly sessionID: SessionID;
  readonly message: string;
  readonly respondable: boolean;
}

export type AnswerResult = 'ok' | 'already_answered' | 'unsupported' | 'unknown';

// given at construction, so no request opens before both callbacks exist
export interface PermissionCallbacks {
  readonly onRequested: (req: PermissionRequest) => void;
  readonly onResolved: (id: string, decision: string) => void;
}

interface PendingRequest {
  readonly req: PermissionRequest;
  readonly cancelTimeout: () => void;
}

// each request resolves exactly once, so the callbacks hear every resolution once
export class PermissionRegistry {
  private readonly callbacks: PermissionCallbacks;

  private readonly timeoutMs: number;

  private readonly clock: Clock;

  private readonly pending = new Map<string, PendingRequest>();

  // tells already_answered from unknown; it keeps the 1000 most recent, so a long-lived daemon
  // cannot grow it without bound, and an answer to a forgotten request gets unknown
  private readonly resolved = new LRUCache<string, SessionID>({ max: 1000 });

  private counter = 0;

  // The clock that times each request's timeout.
  constructor(callbacks: PermissionCallbacks, timeoutMs = 60_000, clock: Clock = systemClock) {
    this.callbacks = callbacks;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
  }

  open(sessionID: SessionID, message: string, respondable: boolean): PermissionRequest {
    const id = `p${++this.counter}`;
    const req: PermissionRequest = { id, sessionID, message, respondable };

    const cancelTimeout = this.clock.schedule(() => {
      this.removeRequest(id, 'deny');
    }, this.timeoutMs);

    this.pending.set(id, { req, cancelTimeout });
    this.callbacks.onRequested(req);

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

  findSessionID(id: string): SessionID | null {
    return this.pending.get(id)?.req.sessionID ?? this.resolved.get(id) ?? null;
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

    entry.cancelTimeout();
    this.pending.delete(id);
    this.resolved.set(id, entry.req.sessionID);
    this.callbacks.onResolved(id, decision);
  }
}
