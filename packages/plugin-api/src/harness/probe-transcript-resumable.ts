import { existsSync } from 'node:fs';
import type { ResumeCheck } from '../agent-adapter';

export function probeTranscriptResumable(session: ResumeCheck): boolean {
  return session.transcriptSource === undefined || existsSync(session.transcriptSource);
}
