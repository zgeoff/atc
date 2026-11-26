import type { AgentAdapter } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { SessionManager } from './create-session-manager';
import type { Session } from './session';

interface ResumeSource {
  readonly sessions: SessionManager['sessions'];
  readonly findProvider: SessionManager['findProvider'];
}

export function hasResumableTranscript(
  manager: ResumeSource,
  id: SessionID,
  findAdapter: (session: Session) => AgentAdapter | null,
): boolean {
  const session = manager.sessions.find((x) => x.id === id);

  if (session === undefined) {
    return false;
  }

  const adapter = findAdapter(session);

  if (adapter === null) {
    return false;
  }

  // A remote session's transcript lives in its host, out of the daemon's
  // reach, so the agent's session id alone makes it resumable.
  if (manager.findProvider(session)?.remote === true) {
    return session.agentSessionID !== undefined;
  }

  return adapter.canResume({
    ...(session.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
    ...(session.transcriptSource === undefined
      ? {}
      : { transcriptSource: session.transcriptSource }),
  });
}
