import type { SessionID } from '@atc/core';
import type { SessionManager } from './sessions';

// The sessions the check reads, with their agents and hosts.
interface ResumeSource {
  readonly sessions: SessionManager['sessions'];
  readonly findAdapter: SessionManager['findAdapter'];
  readonly findProvider: SessionManager['findProvider'];
}

export function hasResumableTranscript(mgr: ResumeSource, id: SessionID): boolean {
  const s = mgr.sessions.find((x) => x.id === id);

  if (s === undefined) {
    return false;
  }

  const adapter = mgr.findAdapter(s.agent);

  if (adapter === null) {
    return false;
  }

  // A remote session's transcript lives in its host, out of the daemon's
  // reach, so the agent's session id alone makes it resumable.
  if (mgr.findProvider(s)?.remote === true) {
    return s.agentSessionID !== undefined;
  }

  return adapter.canResume({
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
    ...(s.transcriptSource === undefined ? {} : { transcriptSource: s.transcriptSource }),
  });
}
