import { existsSync } from 'node:fs';
import type { ResumeCheck } from '../agent-adapter';

/**
 * Whether a session of a harness that resumes from its transcript can
 * resume: its transcript file still exists, or it never reported one, so
 * nothing shows it is gone.
 */
export function canResumeFromTranscript(session: ResumeCheck): boolean {
  return session.transcriptSource === undefined || existsSync(session.transcriptSource);
}
