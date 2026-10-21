import type { SessionID } from '@atc/core';
import type { SessionManager } from './create-session-manager';

// The sessions the check reads, with their agents and hosts.
interface ResumeSource {
  readonly sessions: SessionManager['sessions'];
  readonly findAdapter: SessionManager['findAdapter'];
  readonly findProvider: SessionManager['findProvider'];
}

export function hasResumableTranscript(manager: ResumeSource, id: SessionID): boolean {
  const session = manager.sessions.find((x) => x.id === id);

  if (session === undefined) {
    return false;
  }

  const adapter = manager.findAdapter(session.agent);

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
