import type { SessionID } from '@atc/core';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { SessionRecord, SessionTranscriptRead } from '../daemon-context';
import { getDescriptor } from './get-descriptor';
import { loadTranscriptPage } from './load-transcript-page';
import type { TranscriptPosition } from './load-transcript-page';
import type { PublishedRecords } from './published-records';
import type { SessionManager } from './sessions';

// A page stays far under the protocol's 1 MiB line cap.
const TRANSCRIPT_PAGE_MAX_BYTES = 262_144;

interface SessionReadsDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'collectDescriptors' | 'findAdapter'>;
  readonly store: Pick<StateStore, 'loadLastActivityAt'>;
  readonly records: Pick<PublishedRecords, 'readRecord'>;
}

export class SessionReads {
  private readonly manager: SessionReadsDeps['manager'];

  private readonly store: SessionReadsDeps['store'];

  private readonly records: SessionReadsDeps['records'];

  constructor(deps: SessionReadsDeps) {
    this.manager = deps.manager;
    this.store = deps.store;
    this.records = deps.records;
  }

  // The activity time counts only the session's own trail rows when there
  // is an access.
  async readSessionRecord(
    id: SessionID,
    access: TargetAccess | null,
  ): Promise<SessionRecord | 'missing'> {
    const live = this.manager.sessions.find((x) => x.id === id);

    if (live === undefined) {
      return 'missing';
    }

    // Every session-derived field is taken before the await: a kill or a
    // hook may change the session meanwhile.
    const session = getDescriptor(this.manager, id);
    const prompt = live.prompt ?? null;
    const pending = live.state === 'needs_you' ? { message: live.lastMsg } : null;
    const result = live.result ?? null;
    const createdAt = live.createdAt;

    // the agent session id links rows from before atc ids stayed stable,
    // unless another target resumed it too; under an access it links nothing,
    // since a session that shared it may be gone with its rows still in the trail
    const shared = this.manager.sessions.some(
      (x) =>
        x.agentSessionID === live.agentSessionID &&
        (x.target !== live.target || x.targetIdentity !== live.targetIdentity),
    );

    const linked = access !== null || shared ? undefined : live.agentSessionID;

    const lastEventAt = await this.store.loadLastActivityAt(live.id, linked);
    const sessionRecord = await this.records.readRecord(live.id);

    return {
      session,
      prompt,
      lastActivityAt: lastEventAt ?? createdAt,
      pending,
      result,
      sessionRecord,
    };
  }

  async loadSessionTranscript(
    id: SessionID,
    from: TranscriptPosition | null,
    limit: number,
  ): Promise<SessionTranscriptRead | 'missing' | 'unsupported'> {
    const session = this.manager.sessions.find((x) => x.id === id);

    if (session === undefined) {
      return 'missing';
    }

    const parseLine = this.manager.findAdapter(session.agent)?.parseTranscriptLine;

    if (parseLine === undefined) {
      return 'unsupported';
    }

    const path = session.transcriptPath ?? '';

    if (path === '') {
      return { path, page: { rows: [], offset: 0, more: false } };
    }

    const page = await loadTranscriptPage({
      path,
      from,
      limit,
      maxBytes: TRANSCRIPT_PAGE_MAX_BYTES,
      parseLine,
    });

    return { path, page };
  }
}
