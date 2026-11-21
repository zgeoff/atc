import type { SessionID } from '@atcx/contract';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import { LRUCache } from 'lru-cache';

export interface PermissionRequest {
  readonly id: string;
  readonly sessionID: SessionID;
  readonly message: string;
  readonly respondable: boolean;
}

export type AnswerResult = 'ok' | 'already_answered' | 'unsupported' | 'unknown';

export interface PermissionCallbacks {
  readonly onRequested: (req: PermissionRequest) => void;
  readonly onResolved: (id: string, decision: string) => void;
}

interface PendingRequest {
  readonly req: PermissionRequest;
  readonly cancelTimeout: () => void;
}

export interface PermissionRegistry {
  readonly open: (sessionID: SessionID, message: string, respondable: boolean) => PermissionRequest;
  readonly answer: (id: string, decision: string) => AnswerResult;
  readonly findSessionID: (id: string) => SessionID | null;
  readonly answerAll: (sessionID: SessionID, decision: string) => void;
}

export function createPermissionRegistry(
  callbacks: PermissionCallbacks,
  timeoutMs = 60_000,
  clock: Pick<Clock, 'now' | 'schedule'> = systemClock,
): PermissionRegistry {
  const pending = new Map<string, PendingRequest>();
  const resolved = new LRUCache<string, SessionID>({ max: 1000 });

  let counter = 0;

  const removeRequest = (id: string, decision: string): void => {
    const entry = pending.get(id);

    if (entry === undefined) {
      return;
    }

    entry.cancelTimeout();
    pending.delete(id);
    resolved.set(id, entry.req.sessionID);
    callbacks.onResolved(id, decision);
  };

  return {
    open: (sessionID, message, respondable) => {
      const id = `p${++counter}`;
      const req: PermissionRequest = { id, sessionID, message, respondable };

      const cancelTimeout = clock.schedule(() => {
        removeRequest(id, 'deny');
      }, timeoutMs);

      pending.set(id, { req, cancelTimeout });
      callbacks.onRequested(req);

      return req;
    },

    answer: (id, decision) => {
      if (resolved.has(id)) {
        return 'already_answered';
      }

      const entry = pending.get(id);

      if (entry === undefined) {
        return 'unknown';
      }

      if (!entry.req.respondable) {
        return 'unsupported';
      }

      removeRequest(id, decision);

      return 'ok';
    },

    findSessionID: (id) => pending.get(id)?.req.sessionID ?? resolved.get(id) ?? null,

    answerAll: (sessionID, decision) => {
      for (const [id, entry] of pending) {
        if (entry.req.sessionID === sessionID) {
          removeRequest(id, decision);
        }
      }
    },
  };
}
