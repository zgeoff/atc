import type { Clock } from '@atc/core';
import type { SessionState } from '@atc/protocol';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { createPermissionRegistry } from './create-permission-registry';
import type { AnswerResult } from './create-permission-registry';
import type { HookScope } from './make-hook-runner';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

interface PermissionPromptsDeps {
  readonly clock: Clock;
  readonly emitEvent: (event: EventMsg, scope?: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;
}

export interface PermissionPrompts {
  readonly recordSessionEvent: (kind: SessionEventKind, session: Session) => void;
  readonly findSessionID: (request: string) => SessionID | null;
  readonly answer: (request: string, decision: string) => AnswerResult;
}

export function createPermissionPrompts(deps: PermissionPromptsDeps): PermissionPrompts {
  const lastStates = new Map<SessionID, SessionState>();

  const registry = createPermissionRegistry(
    {
      onRequested: (req) => {
        deps.emitEvent(
          {
            version: PROTOCOL_V,
            ev: 'PermissionRequested',
            request: req.id,
            sessionID: req.sessionID,
            message: req.message,
            respondable: req.respondable,
          },
          deps.findHookScope(req.sessionID),
        );
      },
      onResolved: (id, decision) => {
        deps.emitEvent({ version: PROTOCOL_V, ev: 'PermissionResolved', request: id, decision });
      },
    },
    undefined,
    deps.clock,
  );

  return {
    recordSessionEvent: (kind, session) => {
      if (kind === 'removed') {
        registry.answerAll(session.id, 'dismissed');
        lastStates.delete(session.id);

        return;
      }

      const previous = lastStates.get(session.id);

      lastStates.set(session.id, session.state);

      if (session.state === 'needs_you' && previous !== 'needs_you') {
        registry.open(session.id, session.lastMsg, false);
      }

      if (previous === 'needs_you' && session.state !== 'needs_you') {
        registry.answerAll(session.id, 'dismissed');
      }
    },

    findSessionID: (request) => registry.findSessionID(request),

    answer: (request, decision) => registry.answer(request, decision),
  };
}
