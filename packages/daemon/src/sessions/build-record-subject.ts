import type { ExecutionProvider } from '@atc/plugin-api';
import type { RecordSubject } from './create-published-records';
import type { Session } from './session';

export function buildRecordSubject(
  session: Readonly<Session>,
  provider: ExecutionProvider,
): RecordSubject {
  return {
    session: session.id,
    target: session.target,
    name: session.name,
    transcriptPath: session.transcriptPath ?? null,
    provider,
    host: session.hostKey,
    directory: session.cwd,
    workspace: session.workspace ?? null,
  };
}
