import type { SessionID } from '@atc/core';
import type { StateStore } from '@atc/store';
import type { TargetAccess } from '../auth/target-access';
import type { SessionRecord, SessionTranscriptRead } from '../daemon-context';
import { getDescriptor } from './get-descriptor';
import { loadTranscriptPage } from './load-transcript-page';
import type { TranscriptPosition } from './load-transcript-page';
import type { PublishedRecords } from './published-records';
import type { SessionManager } from './sessions';

// A page stays far under the protocol's 1 MiB line cap.
const TRANSCRIPT_PAGE_MAX_BYTES = 262_144;

interface SessionReadsDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'collectDescriptors' | 'findAdapter'>;
  readonly store: Pick<StateStore, 'loadLastActivityAt'>;
  readonly records: Pick<PublishedRecords, 'findRecord'>;
}

export class SessionReads {
  private readonly mgr: SessionReadsDeps['mgr'];

  private readonly store: SessionReadsDeps['store'];

  private readonly records: SessionReadsDeps['records'];

  constructor(deps: SessionReadsDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.records = deps.records;
  }

  // The activity time counts only the session's own trail rows when there
  // is an access.
  async readSessionRecord(
    id: SessionID,
    access: TargetAccess | null,
  ): Promise<SessionRecord | 'missing'> {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    // Every session-derived field is taken before the await: a kill or a
    // hook may change the session meanwhile.
    const session = getDescriptor(this.mgr, id);
    const prompt = s.prompt ?? null;
    const pending = s.state === 'needs_you' ? { message: s.lastMsg } : null;
    const result = s.result ?? null;
    const createdAt = s.createdAt;

    // the agent session id links rows from before atc ids stayed stable,
    // unless another target resumed it too; under an access it links nothing,
    // since a session that shared it may be gone with its rows still in the trail
    const shared = this.mgr.sessions.some(
      (x) =>
        x.agentSessionID === s.agentSessionID &&
        (x.target !== s.target || x.targetIdentity !== s.targetIdentity),
    );

    const linked = access !== null || shared ? undefined : s.agentSessionID;

    const lastEventAt = await this.store.loadLastActivityAt(s.id, linked);
    const sessionRecord = await this.records.findRecord(s.id);

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
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    const parseLine = this.mgr.findAdapter(s.agent)?.parseTranscriptLine;

    if (parseLine === undefined) {
      return 'unsupported';
    }

    const path = s.transcriptPath ?? '';

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
