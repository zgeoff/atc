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

  recordSessionEvent(kind: SessionEventKind, session: Session): void {
    if (kind === 'removed') {
      this.registry.answerAll(session.id, 'dismissed');
      this.lastStates.delete(session.id);

      return;
    }

    const previous = this.lastStates.get(session.id);

    this.lastStates.set(session.id, session.state);

    if (session.state === 'needs_you' && previous !== 'needs_you') {
      this.registry.open(session.id, session.lastMsg, false);
    }

    if (previous === 'needs_you' && session.state !== 'needs_you') {
      this.registry.answerAll(session.id, 'dismissed');
    }
  }

  findSessionID(request: string): SessionID | null {
    return this.registry.findSessionID(request);
  }

  answer(request: string, decision: string): AnswerResult {
    return this.registry.answer(request, decision);
  }
}
