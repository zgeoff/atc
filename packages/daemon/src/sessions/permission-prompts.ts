import type { Clock, SessionID } from '@atc/core';
import type { SessionState } from '@atc/protocol';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { HookScope } from './make-hook-runner';
import { PermissionRegistry } from './permission-registry';
import type { AnswerResult } from './permission-registry';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

interface PermissionPromptsDeps {
  readonly clock: Clock;
  readonly emitEvent: (event: EventMsg, scope?: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;
}

/**
 * Opens a permission request each time a session enters `needs_you`, and
 * dismisses what is pending when the session leaves it, answered in its
 * terminal or ended, or is removed. Each open and each answer goes out as
 * an event. The previous state of each session is kept only to see that
 * transition.
 */
export class PermissionPrompts {
  private readonly registry: PermissionRegistry;

  private readonly lastStates = new Map<SessionID, SessionState>();

  constructor(deps: PermissionPromptsDeps) {
    this.registry = new PermissionRegistry(
      {
        onRequested: (req) => {
          deps.emitEvent(
            {
              v: PROTOCOL_V,
              ev: 'PermissionRequested',
              request: req.id,
              s: req.sessionID,
              message: req.message,
              respondable: req.respondable,
            },
            deps.findHookScope(req.sessionID),
          );
        },
        onResolved: (id, decision) => {
          deps.emitEvent({ v: PROTOCOL_V, ev: 'PermissionResolved', request: id, decision });
        },
      },
      undefined,
      deps.clock,
    );
  }

  recordSessionEvent(kind: SessionEventKind, s: Session): void {
    if (kind === 'removed') {
      this.registry.answerAll(s.id, 'dismissed');
      this.lastStates.delete(s.id);

      return;
    }

    const prev = this.lastStates.get(s.id);

    this.lastStates.set(s.id, s.state);

    if (s.state === 'needs_you' && prev !== 'needs_you') {
      this.registry.open(s.id, s.lastMsg, false);
    }

    if (prev === 'needs_you' && s.state !== 'needs_you') {
      this.registry.answerAll(s.id, 'dismissed');
    }
  }

  findSessionID(request: string): SessionID | null {
    return this.registry.findSessionID(request);
  }

  answer(request: string, decision: string): AnswerResult {
    return this.registry.answer(request, decision);
  }
}
