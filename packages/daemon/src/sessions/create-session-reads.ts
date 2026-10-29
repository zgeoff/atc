import type { StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { SessionRecord, SessionTranscriptRead } from '../daemon-context';
import type { PublishedRecords } from './create-published-records';
import type { SessionManager } from './create-session-manager';
import { getDescriptor } from './get-descriptor';
import { loadTranscriptPage } from './load-transcript-page';
import type { TranscriptPosition } from './load-transcript-page';
import { makeGuestTranscriptReader } from './make-guest-transcript-reader';
import { readLocalTranscriptWindow } from './read-local-transcript-window';

// A page stays far under the protocol's 1 MiB line cap.
const TRANSCRIPT_PAGE_MAX_BYTES = 262_144;

interface SessionReadsDeps {
  readonly manager: Pick<
    SessionManager,
    'sessions' | 'collectDescriptors' | 'findAdapter' | 'findProvider' | 'requireExecution'
  >;
  readonly store: Pick<StateStore, 'loadLastActivityAt'>;
  readonly records: Pick<PublishedRecords, 'readRecord'>;
}

export interface SessionReads {
  // The activity time counts only the session's own trail rows when there
  // is an access.
  readonly readSessionRecord: (
    id: SessionID,
    access: TargetAccess | null,
  ) => Promise<SessionRecord | 'missing'>;

  readonly loadSessionTranscript: (
    id: SessionID,
    from: TranscriptPosition | null,
    limit: number,
  ) => Promise<SessionTranscriptRead | 'missing' | 'unsupported'>;
}

export function createSessionReads(deps: SessionReadsDeps): SessionReads {
  const manager = deps.manager;
  const store = deps.store;
  const records = deps.records;

  return {
    readSessionRecord: async (id, access) => {
      const live = manager.sessions.find((x) => x.id === id);

      if (live === undefined) {
        return 'missing';
      }

      // Every session-derived field is taken before the await: a kill or a
      // hook may change the session meanwhile.
      const session = getDescriptor(manager, id);
      const prompt = live.prompt ?? null;
      const pending = live.state === 'needs_you' ? { message: live.lastMsg } : null;
      const result = live.result ?? null;
      const createdAt = live.createdAt;

      // the agent session id links rows from before atc ids stayed stable,
      // unless another target resumed it too; under an access it links nothing,
      // since a session that shared it may be gone with its rows still in the trail
      const shared = manager.sessions.some(
        (x) =>
          x.agentSessionID === live.agentSessionID &&
          (x.target !== live.target || x.targetIdentity !== live.targetIdentity),
      );

      const linked = access !== null || shared ? undefined : live.agentSessionID;

      const lastEventAt = await store.loadLastActivityAt(live.id, linked);
      const sessionRecord = await records.readRecord(live.id);

      return {
        session,
        prompt,
        lastActivityAt: lastEventAt ?? createdAt,
        pending,
        result,
        sessionRecord,
      };
    },

    loadSessionTranscript: async (id, from, limit) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return 'missing';
      }

      const parseLine = manager.findAdapter(session.agent)?.parseTranscriptLine;

      if (parseLine === undefined) {
        return 'unsupported';
      }

      const path = session.transcriptPath ?? '';

      if (path === '') {
        return { path, page: { rows: [], offset: 0, more: false } };
      }

      // A remote read runs a command on the session's target, so it refuses as any other command
      // does once the target the session was bound to changed or went away.
      const remote = manager.findProvider(session)?.remote === true;
      const provider = remote ? manager.requireExecution(session, 'run').provider : null;

      const page = await loadTranscriptPage({
        path,
        from,
        limit,
        maxBytes: TRANSCRIPT_PAGE_MAX_BYTES,
        parseLine,
        readWindow:
          provider === null
            ? readLocalTranscriptWindow
            : makeGuestTranscriptReader(provider, session.hostKey),
      });

      return { path, page };
    },
  };
}
